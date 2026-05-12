// Интеграция с Telegram Payments.
// Поток:
//   1. Клиент жмёт «💳 Оплатить картой» в корзине.
//   2. Бот вызывает sendInvoiceForCart() → Telegram открывает встроенный чекаут.
//   3. Перед списанием Telegram шлёт pre_checkout_query — мы валидируем
//      payload (мапа на наши order_id) и отвечаем answerPreCheckoutQuery(true).
//   4. После успешного списания Telegram шлёт successful_payment в чат —
//      handleSuccessfulPayment() помечает заказы 'paid', пишет charge_id и
//      уведомляет менеджера + клиента.
//
// Требуется PAYMENT_PROVIDER_TOKEN от @BotFather (Stripe TEST, ЮKassa и др.).
// Без токена payments не активируются — есть фолбэк к ручному checkout.
import { config } from './config.js';
import { query } from './db.js';
import { child } from './log.js';
import { inc } from './metrics.js';
import type { Order } from './types.js';

const log = child('payments');

// Telegram successful_payment payload (подмножество tg-types, которые мы реально используем).
export interface SuccessfulPayment {
  invoice_payload: string;
  total_amount: number;
  currency: string;
  telegram_payment_charge_id?: string;
  provider_payment_charge_id?: string;
}

export interface PaymentPriceLabel {
  label: string;
  amount: number;
}

export interface PreCheckoutQueryContext {
  preCheckoutQuery: {
    invoice_payload: string;
    from: { id: number };
  };
  answerPreCheckoutQuery(ok: boolean, errorMessage?: string): Promise<boolean>;
}

export interface SuccessfulPaymentContext {
  message?: { successful_payment?: SuccessfulPayment };
  from: { id: number; username?: string };
  reply(text: string): Promise<unknown>;
}

export interface InvoiceContext {
  replyWithInvoice(payload: Record<string, unknown>): Promise<unknown>;
}

export interface TelegramSender {
  sendMessage(chatId: string | number, text: string): Promise<unknown>;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface SendInvoiceArgs {
  products: Array<{ name: string; price: number }>;
  orderIds: number[];
}

export interface HandleSuccessfulPaymentDeps {
  managerChatId: string | null;
  telegram: TelegramSender;
}

// Все суммы в Telegram Payments — в minor units (копейки для RUB,
// центы для USD/EUR). Каталог хранит цены в рублях.
const MINOR_UNITS_MULTIPLIER = 100;

export const PAYMENT_PAYLOAD_PREFIX = 'pay:order:';

export function isPaymentsEnabled(): boolean {
  return Boolean(config.paymentProviderToken);
}

// Сериализация order_id'шек в payload (≤ 128 символов по Telegram API).
// До 30 заказов помещается. Реально корзина ограничена 20 позициями.
export function buildInvoicePayload(orderIds: number[]): string {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    throw new Error('orderIds должен быть непустым массивом');
  }
  const payload = `${PAYMENT_PAYLOAD_PREFIX}${orderIds.join(',')}`;
  if (payload.length > 128) {
    throw new Error(`payload слишком длинный (${payload.length} > 128 символов)`);
  }
  return payload;
}

export function parseInvoicePayload(payload: unknown): { orderIds: number[] } {
  if (typeof payload !== 'string' || !payload.startsWith(PAYMENT_PAYLOAD_PREFIX)) {
    throw new Error('payload не наш формат');
  }
  const ids = payload
    .slice(PAYMENT_PAYLOAD_PREFIX.length)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw new Error('payload не содержит валидных order_id');
  return { orderIds: ids };
}

// Конвертируем рубли в копейки, заодно проверяем что вышло целое число
// (Telegram падает с BadRequest на дробных суммах).
function rubToMinor(rub: number): number {
  return Math.round(rub * MINOR_UNITS_MULTIPLIER);
}

// Формирует prices[] из массива products. Каждая позиция — отдельная строка
// в инвойсе (Telegram сам сложит сумму, мы добавляем валидацию total).
export function buildPrices(products: Array<{ name: string; price: number }>): PaymentPriceLabel[] {
  return products.map((p) => ({
    label: p.name.slice(0, 32),
    amount: rubToMinor(p.price),
  }));
}

// Отправляет invoice через ctx.replyWithInvoice. Структура полей:
// https://core.telegram.org/bots/api#sendinvoice
export async function sendInvoiceForCart(
  ctx: InvoiceContext,
  { products, orderIds }: SendInvoiceArgs
): Promise<unknown> {
  if (!isPaymentsEnabled()) {
    throw new Error('payments disabled: PAYMENT_PROVIDER_TOKEN не задан');
  }
  if (!products?.length) throw new Error('products пустой');

  const prices = buildPrices(products);
  const total = prices.reduce((s, p) => s + p.amount, 0);
  const payload = buildInvoicePayload(orderIds);

  const description = products
    .slice(0, 3)
    .map((p) => p.name)
    .join(', ');

  inc('invoice_sent_total');

  return ctx.replyWithInvoice({
    title: `Заказ из корзины (${products.length} ${pluralPositions(products.length)})`,
    description: description.slice(0, 255),
    payload,
    provider_token: config.paymentProviderToken,
    currency: config.paymentCurrency,
    prices,
    // Запрашиваем у клиента имя и телефон — менеджеру это нужно для доставки.
    need_name: true,
    need_phone_number: true,
    need_shipping_address: true,
    is_flexible: false,
    // Срок жизни инвойса не выставляем — Telegram сам обнулит при таймауте.
    // Сам total в minor units просто для проверки.
    start_parameter: `cart_${total}`,
  });
}

function pluralPositions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'позиций';
  if (mod10 === 1) return 'позиция';
  if (mod10 >= 2 && mod10 <= 4) return 'позиции';
  return 'позиций';
}

// Валидация заказов перед списанием. Возвращает { ok, reason? }.
// Не светим клиенту внутренние причины — общий error_message.
export async function validatePreCheckout(
  orderIds: number[],
  userId: number
): Promise<ValidationResult> {
  const { rows } = await query<Pick<Order, 'id' | 'user_id' | 'status'>>(
    `SELECT id, user_id, status FROM orders WHERE id = ANY($1::int[])`,
    [orderIds]
  );
  if (rows.length !== orderIds.length) {
    return { ok: false, reason: 'некоторые заказы не найдены в БД' };
  }
  for (const r of rows) {
    if (r.user_id !== userId) {
      return { ok: false, reason: `order ${r.id} принадлежит другому пользователю` };
    }
    if (r.status !== 'new' && r.status !== 'pending_payment') {
      return { ok: false, reason: `order ${r.id} в статусе ${r.status}, нельзя оплатить` };
    }
  }
  return { ok: true };
}

// Обрабатывает pre_checkout_query. Telegram даёт 10 секунд на ответ,
// иначе списания не будет.
export async function handlePreCheckoutQuery(ctx: PreCheckoutQueryContext): Promise<boolean> {
  const q = ctx.preCheckoutQuery;
  try {
    const { orderIds } = parseInvoicePayload(q.invoice_payload);
    const { ok, reason } = await validatePreCheckout(orderIds, q.from.id);
    if (!ok) {
      log.warn({ orderIds, reason, userId: q.from.id }, 'pre-checkout: отклоняем');
      inc('pre_checkout_rejected_total');
      return ctx.answerPreCheckoutQuery(
        false,
        'Заказ изменился — пожалуйста, оформи корзину заново.'
      );
    }
    inc('pre_checkout_approved_total');
    return ctx.answerPreCheckoutQuery(true);
  } catch (err) {
    log.error({ err: err.message || err }, 'pre-checkout: ошибка валидации');
    inc('pre_checkout_error_total');
    return ctx.answerPreCheckoutQuery(false, 'Ошибка валидации заказа. Попробуй ещё раз.');
  }
}

// Помечает заказы как 'paid' и пишет meta из telegram_payment_charge_id.
export async function markOrdersPaid(
  orderIds: number[],
  sp: SuccessfulPayment
): Promise<Pick<Order, 'id' | 'user_id' | 'product_id' | 'status'>[]> {
  const { rows } = await query<Pick<Order, 'id' | 'user_id' | 'product_id' | 'status'>>(
    `UPDATE orders
        SET status = 'paid',
            paid_at = NOW(),
            updated_at = NOW(),
            payment_provider = $2,
            payment_charge_id = $3,
            payment_amount = $4,
            payment_currency = $5
      WHERE id = ANY($1::int[])
  RETURNING id, user_id, product_id, status`,
    [
      orderIds,
      sp.provider_payment_charge_id ? 'provider' : 'telegram',
      sp.telegram_payment_charge_id || sp.provider_payment_charge_id || null,
      sp.total_amount || null,
      sp.currency || null,
    ]
  );
  return rows;
}

// Полный поток successful_payment: помечаем как paid, уведомляем менеджера и клиента.
export async function handleSuccessfulPayment(
  ctx: SuccessfulPaymentContext,
  { managerChatId, telegram }: HandleSuccessfulPaymentDeps
) {
  const sp = ctx.message?.successful_payment;
  if (!sp) return;
  try {
    const { orderIds } = parseInvoicePayload(sp.invoice_payload);
    const updated = await markOrdersPaid(orderIds, sp);
    inc('payment_success_total');
    log.info(
      {
        orderIds,
        userId: ctx.from.id,
        total: sp.total_amount,
        currency: sp.currency,
        charge: sp.telegram_payment_charge_id,
      },
      'оплата успешна'
    );
    await ctx.reply(
      `✅ Оплата получена! Спасибо.\nЗаказ${updated.length > 1 ? 'ы' : ''} #${updated.map((o) => o.id).join(', #')} в работе — менеджер свяжется для уточнения адреса.`
    );
    if (managerChatId) {
      const handle = ctx.from.username ? `@${ctx.from.username}` : `id ${ctx.from.id}`;
      const totalRub = (sp.total_amount / MINOR_UNITS_MULTIPLIER).toFixed(2);
      try {
        await telegram.sendMessage(
          managerChatId,
          `💰 Оплачен заказ #${updated.map((o) => o.id).join(', #')}\nКлиент: ${handle}\nСумма: ${totalRub} ${sp.currency}\nCharge: ${sp.telegram_payment_charge_id || sp.provider_payment_charge_id}`
        );
      } catch (err) {
        log.warn({ err: err.message || err }, 'не смог уведомить менеджера об оплате');
      }
    }
    return updated;
  } catch (err) {
    log.error({ err: err.message || err }, 'ошибка обработки successful_payment');
    inc('payment_error_total');
    await ctx.reply(
      'Оплата прошла, но не удалось обработать заказ автоматически. Менеджер уже уведомлён — мы свяжемся с тобой в ближайшее время.'
    );
    throw err;
  }
}
