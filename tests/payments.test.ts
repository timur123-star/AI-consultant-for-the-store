import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем db и config до импорта src/payments.js.
const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({ query: queryMock }));

const configMock = {
  paymentProviderToken: 'PROV_TOKEN_TEST',
  paymentCurrency: 'RUB',
};
vi.mock('../src/config.js', () => ({ config: configMock }));

const {
  isPaymentsEnabled,
  buildInvoicePayload,
  parseInvoicePayload,
  buildPrices,
  sendInvoiceForCart,
  validatePreCheckout,
  handlePreCheckoutQuery,
  markOrdersPaid,
  handleSuccessfulPayment,
  PAYMENT_PAYLOAD_PREFIX,
} = await import('../src/payments.js');

beforeEach(() => {
  queryMock.mockReset();
  configMock.paymentProviderToken = 'PROV_TOKEN_TEST';
  configMock.paymentCurrency = 'RUB';
});

describe('isPaymentsEnabled', () => {
  it('true когда токен задан', () => {
    expect(isPaymentsEnabled()).toBe(true);
  });
  it('false когда токен пустой', () => {
    configMock.paymentProviderToken = '';
    expect(isPaymentsEnabled()).toBe(false);
  });
});

describe('payload (build/parse)', () => {
  it('build → parse round-trip', () => {
    const payload = buildInvoicePayload([1, 2, 3]);
    expect(payload.startsWith(PAYMENT_PAYLOAD_PREFIX)).toBe(true);
    expect(parseInvoicePayload(payload)).toEqual({ orderIds: [1, 2, 3] });
  });

  it('build падает на пустой массив', () => {
    expect(() => buildInvoicePayload([])).toThrow(/непустым массивом/);
  });

  it('build падает на слишком длинный payload', () => {
    const huge = Array.from({ length: 30 }, (_, i) => 1_000_000 + i);
    expect(() => buildInvoicePayload(huge)).toThrow(/слишком длинный/);
  });

  it('parse игнорирует невалидные id', () => {
    const payload = `${PAYMENT_PAYLOAD_PREFIX}1,abc,2,-1`;
    expect(parseInvoicePayload(payload)).toEqual({ orderIds: [1, 2] });
  });

  it('parse падает на не-наш формат', () => {
    expect(() => parseInvoicePayload('hello')).toThrow(/не наш формат/);
    expect(() => parseInvoicePayload(`${PAYMENT_PAYLOAD_PREFIX}only-bad-stuff`)).toThrow(
      /валидных order_id/
    );
  });
});

describe('buildPrices', () => {
  it('конвертирует рубли в копейки', () => {
    const prices = buildPrices([
      { name: 'Сумка кожаная', price: 5000 },
      { name: 'Ремень', price: 1500 },
    ]);
    expect(prices).toEqual([
      { label: 'Сумка кожаная', amount: 500000 },
      { label: 'Ремень', amount: 150000 },
    ]);
  });

  it('обрезает label до 32 символов (Telegram-лимит)', () => {
    const prices = buildPrices([{ name: 'a'.repeat(50), price: 100 }]);
    expect(prices[0].label.length).toBe(32);
  });
});

describe('sendInvoiceForCart', () => {
  function makeCtx() {
    return { replyWithInvoice: vi.fn().mockResolvedValue({ message_id: 42 }) };
  }

  it('падает если payments выключены', async () => {
    configMock.paymentProviderToken = '';
    await expect(
      sendInvoiceForCart(makeCtx(), { products: [{ name: 'X', price: 1 }], orderIds: [1] })
    ).rejects.toThrow(/payments disabled/);
  });

  it('падает если корзина пустая', async () => {
    await expect(sendInvoiceForCart(makeCtx(), { products: [], orderIds: [1] })).rejects.toThrow(
      /products пустой/
    );
  });

  it('зовёт replyWithInvoice с правильными полями', async () => {
    const ctx = makeCtx();
    await sendInvoiceForCart(ctx, {
      products: [
        { name: 'Сумка', price: 5000 },
        { name: 'Ремень', price: 1500 },
      ],
      orderIds: [101, 102],
    });
    expect(ctx.replyWithInvoice).toHaveBeenCalledOnce();
    const args = ctx.replyWithInvoice.mock.calls[0][0];
    expect(args.currency).toBe('RUB');
    expect(args.provider_token).toBe('PROV_TOKEN_TEST');
    expect(args.prices).toEqual([
      { label: 'Сумка', amount: 500000 },
      { label: 'Ремень', amount: 150000 },
    ]);
    expect(parseInvoicePayload(args.payload)).toEqual({ orderIds: [101, 102] });
    expect(args.need_phone_number).toBe(true);
    expect(args.need_shipping_address).toBe(true);
  });
});

describe('validatePreCheckout', () => {
  it('ok когда все заказы существуют, принадлежат юзеру и в статусе new/pending_payment', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 1, user_id: 100, status: 'pending_payment' },
        { id: 2, user_id: 100, status: 'new' },
      ],
    });
    expect(await validatePreCheckout([1, 2], 100)).toEqual({ ok: true });
  });

  it('reject если заказ в неподходящем статусе', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, user_id: 100, status: 'paid' }],
    });
    const res = await validatePreCheckout([1], 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/paid/);
  });

  it('reject если заказ принадлежит другому юзеру', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, user_id: 999, status: 'pending_payment' }],
    });
    const res = await validatePreCheckout([1], 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/другому/);
  });

  it('reject если хоть один заказ не найден в БД', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 100, status: 'new' }] });
    const res = await validatePreCheckout([1, 2], 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/не найдены/);
  });
});

describe('handlePreCheckoutQuery', () => {
  interface MakeCtxArgs {
    payload?: string;
    userId?: number;
    statuses?: string[];
  }
  function makeCtx({
    payload,
    userId = 100,
    statuses: _statuses = ['pending_payment'],
  }: MakeCtxArgs = {}) {
    return {
      preCheckoutQuery: { invoice_payload: payload as string, from: { id: userId } },
      answerPreCheckoutQuery: vi.fn().mockResolvedValue(true),
      _statuses,
    };
  }

  it('approve успешный payload', async () => {
    const ctx = makeCtx({ payload: `${PAYMENT_PAYLOAD_PREFIX}1` });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, user_id: 100, status: 'pending_payment' }],
    });
    await handlePreCheckoutQuery(ctx);
    expect(ctx.answerPreCheckoutQuery).toHaveBeenCalledWith(true);
  });

  it('reject невалидный payload', async () => {
    const ctx = makeCtx({ payload: 'garbage' });
    await handlePreCheckoutQuery(ctx);
    expect(ctx.answerPreCheckoutQuery.mock.calls[0][0]).toBe(false);
  });

  it('reject когда validatePreCheckout fail', async () => {
    const ctx = makeCtx({ payload: `${PAYMENT_PAYLOAD_PREFIX}1` });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, user_id: 999, status: 'new' }] });
    await handlePreCheckoutQuery(ctx);
    expect(ctx.answerPreCheckoutQuery.mock.calls[0][0]).toBe(false);
  });
});

describe('markOrdersPaid + handleSuccessfulPayment', () => {
  it('markOrdersPaid обновляет в БД и возвращает строки', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 1, user_id: 100, product_id: 5, status: 'paid' },
        { id: 2, user_id: 100, product_id: 6, status: 'paid' },
      ],
    });
    const rows = await markOrdersPaid([1, 2], {
      invoice_payload: `${PAYMENT_PAYLOAD_PREFIX}1.2`,
      telegram_payment_charge_id: 'CH123',
      total_amount: 650000,
      currency: 'RUB',
    });
    expect(rows).toHaveLength(2);
    expect(queryMock).toHaveBeenCalledOnce();
    const sql = queryMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE orders/);
    expect(sql).toMatch(/status = 'paid'/);
  });

  it('handleSuccessfulPayment отвечает клиенту и менеджеру', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const ctx = {
      message: {
        successful_payment: {
          invoice_payload: `${PAYMENT_PAYLOAD_PREFIX}1`,
          telegram_payment_charge_id: 'CH1',
          provider_payment_charge_id: 'PV1',
          total_amount: 500000,
          currency: 'RUB',
        },
      },
      from: { id: 100, username: 'alice' },
      reply: vi.fn().mockResolvedValue({}),
    };
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, user_id: 100, product_id: 5, status: 'paid' }],
    });
    await handleSuccessfulPayment(ctx, {
      managerChatId: 'MGR',
      telegram: { sendMessage },
    });
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply.mock.calls[0][0]).toMatch(/Оплата получена/);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toMatch(/CH1/);
  });

  it('handleSuccessfulPayment ничего не делает без successful_payment', async () => {
    const ctx = {
      message: {},
      from: { id: 100, username: 'alice' },
      reply: vi.fn().mockResolvedValue({}),
    };
    await handleSuccessfulPayment(ctx, {
      managerChatId: null,
      telegram: { sendMessage: vi.fn() },
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
