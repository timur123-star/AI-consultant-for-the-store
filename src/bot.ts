import { Telegraf, Markup, type Context, type NarrowedContext } from 'telegraf';
import type { Update, CallbackQuery, Message } from 'telegraf/types';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import {
  connectRedis,
  closeRedis,
  getHistory,
  appendHistory,
  clearHistory,
  checkRateLimit,
} from './session.js';
import { addToCart, removeFromCart, getCartItems, clearCart } from './cart.js';
import { createCarousel, getCarousel } from './carousel.js';
import {
  findProducts,
  formatProductsForPrompt,
  getFeaturedProducts,
  getProductById,
  textSearchProducts,
} from './rag.js';
import { chatComplete } from './llm.js';
import { FALLBACK_REPLY, WELCOME_TEXT } from './prompt.js';
import { buildPromptForUser } from './prompt-ab.js';
import {
  logConversation,
  recordOrder,
  getStats,
  updateOrderStatus,
  getRecentOrders,
} from './logger.js';
import { query, closeDb } from './db.js';
import { warmupEmbeddings } from './embeddings.js';
import { child } from './log.js';
import { isAdmin, isManager } from './access.js';
import { statusUpdateMessage } from './order-status.js';
import { inc, recordLatency } from './metrics.js';
import { captureException, shutdownTelemetry } from './telemetry.js';
import { transcribeVoiceMessage, MAX_VOICE_SECONDS } from './voice.js';
import {
  isPaymentsEnabled,
  sendInvoiceForCart,
  handlePreCheckoutQuery,
  handleSuccessfulPayment,
} from './payments.js';
import {
  cartKeyboard,
  managerOrderKeyboard,
  formatCartSummary,
  STATUS_LABELS,
  carouselKeyboard,
  carouselCaption,
  categoryGridKeyboard,
} from './ui.js';

const log = child('bot');

// Лимит длины пользовательского сообщения. Telegram пропускает до 4096 символов,
// но LLM-промпт получит огромный текст и нерелевантный поиск — отрежем заранее.
const MAX_USER_MESSAGE_CHARS = 1000;

const bot: Telegraf<Context> = new Telegraf(config.telegramBotToken, { handlerTimeout: 60_000 });

const mainMenu = Markup.keyboard([
  ['🛍 Каталог', '🌟 Популярное'],
  ['🧺 Корзина', '🧭 Помощь с выбором'],
  ['📦 Доставка и оплата', '💬 Связаться с менеджером'],
]).resize();

// === Команды ===

bot.start(async (ctx) => {
  try {
    await clearHistory(ctx.from.id);
  } catch (err) {
    log.error({ err: err.message || err }, '/start: не смог очистить историю');
  }
  await ctx.reply(WELCOME_TEXT, mainMenu);
});

bot.command('ping', (ctx) => ctx.reply('pong'));

// /version — показывает текущую версию бота. Полезно в проде при разборе багов
// — пользователь может прислать скрин и мы сразу поймём какая версия работает.
bot.command('version', async (ctx) => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    const sha = process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || 'dev';
    await ctx.reply(`версия: ${pkg.version}
commit: ${String(sha).slice(0, 7)}
node: ${process.version}`);
  } catch (err) {
    log.warn({ err: err.message || err }, '/version: не смог прочитать package.json');
    await ctx.reply('Не смог прочитать версию.');
  }
});

// /cancel — клиент отменяет свой последний заказ, если тот ещё не отправлен/доставлен.
bot.command('cancel', async (ctx) => {
  const { rows } = await query(
    `SELECT id, status FROM orders
      WHERE user_id = $1 AND status IN ('new', 'confirmed')
   ORDER BY id DESC LIMIT 1`,
    [ctx.from.id]
  );
  if (!rows.length) {
    return ctx.reply(
      'Нет активных заказов, которые можно отменить. Если это ошибка — напиши менеджеру.'
    );
  }
  const order = await updateOrderStatus(rows[0].id, 'cancelled');
  if (!order) {
    return ctx.reply('Не смог отменить заказ. Попробуй позже или напиши менеджеру.');
  }
  inc('order_cancelled_by_client_total');
  await ctx.reply(`Отменил заказ #${order.id}. Если передумал — просто оформи его заново.`);
  if (config.managerChatId) {
    try {
      await bot.telegram.sendMessage(
        config.managerChatId,
        `☝️ Клиент сам отменил заказ #${order.id}.`
      );
    } catch (err) {
      log.warn(
        { err: err.message || err, orderId: order.id },
        '/cancel: не смог уведомить менеджера'
      );
    }
  }
});

bot.command('help', (ctx) =>
  ctx.reply(
    'Напиши что ищешь обычным языком — я понимаю цены, материалы, цвета, повод (подарок, на работу и т.п.).\n\n' +
      'Подсказки:\n' +
      '• В каталоге товары листаются стрелками ◀ ▶ прямо в одном сообщении — без спама в чат.\n' +
      '• Кнопка 🛒 «В корзину» под каждым товаром — клик и продолжаем подбирать.\n' +
      '• Когда наберёшь нужное — открой 🧺 «Корзина» и оформи заказ одной кнопкой.\n\n' +
      'Команды:\n' +
      '/start — начать заново\n' +
      '/clear — забыть наш разговор\n' +
      '/catalog — категории (через кнопки)\n' +
      '/featured — популярное (карусель)\n' +
      '/cart — моя корзина'
  )
);

bot.command('clear', async (ctx) => {
  await clearHistory(ctx.from.id);
  await ctx.reply('Готово, начнём с чистого листа. Что ищем?');
});

// === Категории и карусель ===

// Base64url категории — влезает в 64 байта callback_data даже для кириллицы.
function encodeCategory(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url');
}
function decodeCategory(code: string): string | null {
  try {
    return Buffer.from(code, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

bot.command('catalog', showCatalog);
bot.hears('🛍 Каталог', showCatalog);

async function showCatalog(ctx: Context): Promise<unknown> {
  const { rows } = await query(
    `SELECT category, COUNT(*)::int AS cnt FROM products WHERE in_stock GROUP BY category ORDER BY cnt DESC`
  );
  if (!rows.length) return ctx.reply('Каталог пока пуст.');
  const categories = rows.map((r) => ({
    name: r.category,
    count: r.cnt,
    key: encodeCategory(r.category),
  }));
  await ctx.reply('🛍 *Каталог КожаМастер*\n\nВыбери категорию или сразу напиши что ищешь:', {
    parse_mode: 'Markdown',
    ...categoryGridKeyboard(categories),
  });
}

bot.command('featured', showFeatured);
bot.hears('🌟 Популярное', showFeatured);

async function showFeatured(ctx: Context): Promise<unknown> {
  await ctx.sendChatAction('upload_photo');
  const items = await getFeaturedProducts(6);
  if (!items.length) {
    return ctx.reply('Каталог пока пуст. Загляни позже.');
  }
  await startCarousel(ctx, items, '🌟 Популярное от КожаМастер');
}

// Стартует новую карусель — разовое сообщение с фото + навигация.
interface CarouselProduct {
  id: number;
  sku?: string;
  name: string;
  description: string;
  price: number;
  category: string;
  in_stock?: boolean;
  image_url?: string | null;
}

async function startCarousel(
  ctx: Context,
  products: CarouselProduct[],
  title: string
): Promise<void> {
  const ids = products.map((p) => p.id);
  const token = await createCarousel(ids, { title });
  const product = products[0];
  const caption = carouselCaption(product, { title });
  const keyboard = carouselKeyboard({
    token,
    index: 0,
    total: ids.length,
    productId: product.id,
  });
  try {
    if (product.image_url) {
      await ctx.replyWithPhoto(product.image_url, {
        caption,
        parse_mode: 'Markdown',
        ...keyboard,
      });
    } else {
      await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (err) {
    log.warn({ err: err.message || err, sku: product.sku }, 'карусель: fallback на текст');
    await ctx.reply(`${product.name} — ${product.price}₽\n\n${product.description}`, keyboard);
  }
}

// Открывает конкретный индекс в существующей карусели через editMessageMedia.
async function navigateCarousel(
  ctx: NarrowedContext<Context, Update.CallbackQueryUpdate>,
  token: string,
  index: number
): Promise<void> {
  const car = await getCarousel(token);
  if (!car || !car.ids.length) {
    await ctx.answerCbQuery('Подборка устарела, начни снова', { show_alert: false });
    return;
  }
  const idx = Math.max(0, Math.min(index, car.ids.length - 1));
  const product = await getProductById(car.ids[idx]);
  if (!product) {
    await ctx.answerCbQuery('Товар больше недоступен');
    return;
  }
  const caption = carouselCaption(product, { title: car.title });
  const keyboard = carouselKeyboard({
    token,
    index: idx,
    total: car.ids.length,
    productId: product.id,
  });
  try {
    if (product.image_url) {
      await ctx.editMessageMedia(
        {
          type: 'photo',
          media: product.image_url,
          caption,
          parse_mode: 'Markdown',
        },
        keyboard
      );
    } else {
      await ctx.editMessageCaption(caption, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (/message is not modified/i.test(msg)) {
      // Нормально — тыкнули на тот же товар.
      await ctx.answerCbQuery();
      return;
    }
    log.warn({ err: msg, sku: product.sku }, 'не смог обновить карусель в editMessageMedia');
  }
  await ctx.answerCbQuery();
}

bot.command('cart', showCart);
bot.hears('🧺 Корзина', showCart);

async function showCart(ctx: Context): Promise<unknown> {
  const ids = await getCartItems(ctx.from!.id);
  if (!ids.length) {
    return ctx.reply('Корзина пуста. Напиши что искать — добавлю товары сюда.');
  }
  const { rows } = await query(
    `SELECT id, sku, name, price, category FROM products WHERE id = ANY($1::int[]) ORDER BY name`,
    [ids]
  );
  const total = rows.reduce((sum, p) => sum + p.price, 0);
  await ctx.reply(formatCartSummary(rows, total), {
    parse_mode: 'Markdown',
    ...cartKeyboard(rows),
  });
}

bot.hears('🧭 Помощь с выбором', (ctx) =>
  ctx.reply('Опиши для кого подарок или что ищешь — подскажу.')
);
bot.hears('📦 Доставка и оплата', (ctx) =>
  ctx.reply(
    'Доставка СДЭК/Почтой по России — 300-800₽, 2-7 дней.\n' +
      'Москва курьером — 500₽, в день заказа.\n' +
      'Оплата: карта онлайн, перевод, наличные при получении.\n' +
      'Возврат в течение 14 дней.'
  )
);
bot.hears('💬 Связаться с менеджером', (ctx) =>
  ctx.reply('Напиши менеджеру: @kozhamaster_manager')
);

// === Admin / Manager ===

bot.command('reindex', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply('Запускаю переиндексацию каталога… это займёт минуту.');
  try {
    const { indexCatalog } = await import('../scripts/index-catalog.js');
    const n = await indexCatalog(undefined);
    await ctx.reply(`Готово, проиндексировано товаров: ${n}`);
  } catch (err) {
    log.error({ err }, 'ошибка переиндексации');
    await ctx.reply(`Ошибка: ${err.message}`);
  }
});

bot.command('search', async (ctx) => {
  if (!isManager(ctx.from.id)) return;
  const q = ctx.message.text.replace(/^\/search\s*/, '').trim();
  if (!q) {
    return ctx.reply('Использование: /search <запрос>\nПример: /search BAG-001 или /search сумка');
  }
  const items = await textSearchProducts(q, { limit: 10 });
  if (!items.length) return ctx.reply(`По запросу «${q}» ничего не нашлось.`);
  const lines = items.map(
    (p) =>
      `• [${p.sku}] ${p.name} — ${p.price}₽ (${p.category})${p.in_stock ? '' : ' — НЕТ В НАЛИЧИИ'}`
  );
  await ctx.reply(`Найдено ${items.length}:\n\n${lines.join('\n')}`);
});

bot.command('orders', async (ctx) => {
  if (!isManager(ctx.from.id)) return;
  const items = await getRecentOrders(10);
  if (!items.length) return ctx.reply('Заказов пока нет.');
  const lines = items.map((o) => {
    const handle = o.username ? `@${o.username}` : `id ${o.user_id}`;
    const status = (STATUS_LABELS as Record<string, string>)[o.status] || o.status;
    const time = new Date(o.created_at).toLocaleString('ru-RU');
    return `#${o.id} — ${o.product_name} (${o.price}₽)\n   ${handle} — ${status} — ${time}`;
  });
  await ctx.reply(`📦 Последние ${items.length} заказов:\n\n${lines.join('\n\n')}`);
});

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const s = await getStats();
  const top = s.topProducts.length
    ? s.topProducts.map((p) => `  • ${p.name} — ${p.cnt}`).join('\n')
    : '  (заказов за неделю не было)';
  await ctx.reply(
    `📊 Статистика\n\n` +
      `Диалоги: ${s.conversations.total} всего, ${s.conversations.last_24h} за 24ч\n` +
      `Уникальных пользователей: ${s.conversations.unique_users}\n` +
      `Заказы: ${s.orders.total} всего, ${s.orders.last_24h} за 24ч\n\n` +
      `Топ товаров за неделю:\n${top}`
  );
});

// === Callback queries: корзина и менеджер ===

bot.on('callback_query', async (ctx, next) => {
  const callback = ctx.callbackQuery as CallbackQuery.DataQuery;
  const data = callback.data || '';

  // Добавить в корзину
  let m = /^cart_add_(\d+)$/.exec(data);
  if (m) {
    const productId = Number(m[1]);
    const product = await getProductById(productId);
    if (!product) {
      return ctx.answerCbQuery('Товар больше не доступен');
    }
    const { added, size, limit } = await addToCart(ctx.from.id, productId);
    if (!added && size >= limit) {
      await ctx.answerCbQuery(`Лимит корзины ${limit}. Открой 🧺 и оформи или убери лишнее.`, {
        show_alert: true,
      });
      return;
    }
    const message = added ? `✅ Добавлено! В корзине: ${size}` : `Уже в корзине. Всего: ${size}`;
    await ctx.answerCbQuery(message);
    return;
  }

  // Удалить из корзины
  m = /^cart_rm_(\d+)$/.exec(data);
  if (m) {
    await removeFromCart(ctx.from.id, Number(m[1]));
    await ctx.answerCbQuery('Убрано');
    await showCart(ctx);
    return;
  }

  // Очистить корзину
  if (data === 'cart_clear') {
    await clearCart(ctx.from.id);
    await ctx.answerCbQuery('Корзина очищена');
    await ctx.reply('Корзина очищена. Хочешь начать выбор заново — просто опиши что ищешь.');
    return;
  }

  // Открыть корзину
  if (data === 'cart_view') {
    await ctx.answerCbQuery();
    await showCart(ctx);
    return;
  }

  // Оформить заказ
  if (data === 'cart_checkout') {
    await ctx.answerCbQuery();
    return checkout(ctx);
  }

  // Подробнее о товаре
  m = /^info_(\d+)$/.exec(data);
  if (m) {
    const product = await getProductById(Number(m[1]));
    if (!product) return ctx.answerCbQuery('Товар не найден');
    await ctx.answerCbQuery();
    await ctx.reply(
      `*${product.name}*\nSKU: ${product.sku}\nКатегория: ${product.category}\nЦена: ${product.price}₽\n\n${product.description}\n\nТеги: ${product.tags?.join(', ') || '—'}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Навигация по карусели (вперёд/назад)
  m = /^car([NP])_([a-f0-9]+)_(\d+)$/.exec(data);
  if (m) {
    const idx = Number(m[3]);
    await navigateCarousel(ctx, m[2], idx);
    return;
  }

  // Клик на счётчик в середине (noop) — просто подтверждаем, чтобы spinner погас.
  if (data === 'noop') {
    await ctx.answerCbQuery();
    return;
  }

  // Выход в меню категорий из карусели.
  if (data === 'carH') {
    try {
      await ctx.deleteMessage();
    } catch (err) {
      log.warn({ err: err.message || err }, 'carH: deleteMessage фейл');
    }
    await ctx.answerCbQuery();
    await showCatalog(ctx);
    return;
  }

  // Клик по категории в списке (из categoryGridKeyboard) — открываем карусель.
  m = /^cat_([A-Za-z0-9_-]+)$/.exec(data);
  if (m) {
    const categoryName = decodeCategory(m[1]);
    if (!categoryName) return ctx.answerCbQuery('Неверная категория');
    const { rows } = await query(
      `SELECT id, sku, name, description, price, category, in_stock, image_url
         FROM products WHERE category = $1 AND in_stock
        ORDER BY price`,
      [categoryName]
    );
    if (!rows.length) {
      await ctx.answerCbQuery();
      await ctx.reply(`В категории «${categoryName}» пока пусто.`);
      return;
    }
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage(); // убираем список категорий
    } catch {
      // not critical
    }
    await startCarousel(ctx, rows, `${categoryName} — ${rows.length} позиций`);
    return;
  }

  // Клик «🌟 Популярное» из любой inline-клавиатуры.
  if (data === 'featured') {
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      // not critical
    }
    await showFeatured(ctx);
    return;
  }

  // === Менеджерские действия ===
  m = /^mgr_(confirm|ship|cancel)_(\d+)$/.exec(data);
  if (m && !isManager(ctx.from.id)) {
    return ctx.answerCbQuery('Только для менеджера');
  }
  if (m) {
    const action = m[1];
    const orderId = Number(m[2]);
    const newStatus =
      action === 'confirm' ? 'confirmed' : action === 'ship' ? 'shipped' : 'cancelled';
    const order = await updateOrderStatus(orderId, newStatus);
    if (!order) return ctx.answerCbQuery('Заказ не найден');
    await ctx.answerCbQuery(`Статус → ${(STATUS_LABELS as Record<string, string>)[newStatus]}`);
    inc(`order_status_${newStatus}`);
    // Уведомляем клиента
    try {
      await bot.telegram.sendMessage(order.user_id, statusUpdateMessage(order.id, newStatus));
    } catch (err) {
      log.warn({ err: err.message || err, orderId }, 'не смог уведомить клиента');
    }
    return;
  }

  return next();
});

// === Оформление заказа из корзины ===

async function checkout(ctx: Context): Promise<unknown> {
  const userId = ctx.from!.id;
  const ids = await getCartItems(userId);
  if (!ids.length) {
    return ctx.reply('Корзина пуста — нечего оформлять.');
  }
  const { rows: products } = await query(
    `SELECT id, sku, name, price FROM products WHERE id = ANY($1::int[])`,
    [ids]
  );
  const total = products.reduce((s, p) => s + p.price, 0);

  // Создаём заказы — по одной строке на каждую позицию. Статус зависит
  // от того, активны ли Telegram Payments: с оплатой → pending_payment,
  // без — сразу new (ручной checkout, менеджер списывается с клиентом).
  const initialStatus = isPaymentsEnabled() ? 'pending_payment' : 'new';
  const orders: Array<{ orderId: number; product: (typeof products)[number] }> = [];
  for (const p of products) {
    const order = await recordOrder({
      userId,
      username: ctx.from?.username,
      productId: p.id,
      status: initialStatus,
    });
    orders.push({ orderId: order.id, product: p });
  }

  await clearCart(userId);

  if (isPaymentsEnabled()) {
    // Открываем встроенный чекаут Telegram. Дальше: pre_checkout_query → answer →
    // successful_payment → markOrdersPaid → уведомление менеджеру (см. payments.js).
    try {
      await sendInvoiceForCart(ctx as unknown as import('./payments.js').InvoiceContext, {
        products,
        orderIds: orders.map((o) => o.orderId),
      });
      return;
    } catch (err) {
      log.error(
        { err: err.message || err, userId },
        'не удалось отправить инвойс — фолбэк на ручной checkout'
      );
      inc('invoice_send_failed_total');
      // Не падаем — продолжаем по старому пути ниже.
    }
  }

  await ctx.reply(
    `✅ Заявка оформлена!\n\nПозиций: ${products.length}\nИтого: ${total.toLocaleString('ru-RU')}₽\n\nМенеджер @kozhamaster_manager напишет тебе для уточнения адреса доставки и оплаты.`
  );

  // Уведомляем менеджера про каждый заказ с инлайн-кнопками управления.
  if (config.managerChatId) {
    const handle = ctx.from?.username ? `@${ctx.from.username}` : `id ${userId}`;
    for (const { orderId, product } of orders) {
      try {
        await bot.telegram.sendMessage(
          config.managerChatId,
          `🛍 Новый заказ #${orderId}\n\nТовар: ${product.name} (sku ${product.sku})\nЦена: ${product.price}₽\nКлиент: ${handle}`,
          managerOrderKeyboard(orderId)
        );
      } catch (err) {
        log.warn({ err: err.message || err, orderId }, 'не смог уведомить менеджера');
      }
    }
  }
}

// === Текстовые сообщения: основной RAG-флоу ===

// Общий обработчик: RAG → LLM → карусель + история.
// Используется и текстовыми сообщениями, и транскриптами голосовых.
async function handleUserMessage(ctx: Context, userText: string): Promise<void> {
  const userId = ctx.from!.id;
  if (!userText) return;

  await ctx.sendChatAction('typing');

  const startedAt = Date.now();
  try {
    inc('messages_total');
    const products = await findProducts(userText);
    const history = await getHistory(userId);

    let reply;
    let smartFallback = null;
    let promptVariant: string | null = null;
    if (!products.length && history.length === 0) {
      // Первое сообщение и ничего не нашли — экономим квоту LLM,
      // отвечаем фолбэком + предлагаем популярные товары.
      reply = FALLBACK_REPLY;
      smartFallback = await getFeaturedProducts(4);
      inc('fallback_no_match_total');
    } else {
      const productContext = formatProductsForPrompt(products);
      const { prompt: system, variant } = buildPromptForUser(userId, productContext);
      promptVariant = variant;
      const llmStarted = Date.now();
      reply = await chatComplete({ system, history, userMessage: userText });
      const llmMs = Date.now() - llmStarted;
      recordLatency('llm_ms', llmMs);
      recordLatency(`llm_ms_variant_${variant}`, llmMs);
      inc('llm_calls_total');
      inc(`prompt_variant_${variant}_total`);
    }

    // Отправляем текстовый ответ + карусель вместо стопки карточек.
    if (products.length) {
      await ctx.reply(reply);
      await startCarousel(ctx, products, `Подбор по «${userText.slice(0, 40)}»`);
    } else {
      await ctx.reply(reply);
      if (smartFallback?.length) {
        await startCarousel(ctx, smartFallback, 'Вот что сейчас на пике популярности');
      }
    }

    await appendHistory(userId, userText, reply);
    await logConversation({
      userId,
      username: ctx.from?.username,
      userText,
      botText: reply,
      matchedSkus: products.map((p) => p.sku),
      promptVariant,
    });

    recordLatency('message_ms', Date.now() - startedAt);
  } catch (err) {
    inc('errors_total');
    log.error({ err: err.message || err, userId: ctx.from?.id }, 'ошибка обработки сообщения');
    captureException(err, { userId: ctx.from?.id, scope: 'handleUserMessage' });
    // Не светим err.message клиенту — там могут быть внутренние детали.
    await ctx.reply(
      'Что-то пошло не так на нашей стороне. Попробуй ещё раз или напиши менеджеру @kozhamaster_manager.'
    );
  }
}

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const message = ctx.message as Message.TextMessage;
  const userText = (message.text || '').trim().slice(0, MAX_USER_MESSAGE_CHARS);
  if (!userText) return;

  const { allowed, remaining } = await checkRateLimit(userId);
  if (!allowed) {
    inc('rate_limited_total');
    return ctx.reply('Слишком много сообщений подряд, подожди минуту и попробуй ещё раз 🙏');
  }

  await handleUserMessage(ctx, userText);
  if (remaining <= 3) {
    log.warn({ userId, remaining }, 'пользователь приближается к rate-limit');
  }
});

// === Голосовые сообщения: Whisper → текст → тот же RAG-флоу ===

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;
  const voiceMessage = ctx.message as Message.VoiceMessage;
  const voice = voiceMessage.voice;
  if (!voice) return;

  const { allowed } = await checkRateLimit(userId);
  if (!allowed) {
    inc('rate_limited_total');
    return ctx.reply('Слишком много сообщений подряд, подожди минуту и попробуй ещё раз 🙏');
  }

  if (voice.duration && voice.duration > MAX_VOICE_SECONDS) {
    inc('voice_too_long_total');
    return ctx.reply(
      `Голосовое слишком длинное (${voice.duration} с). Максимум ${MAX_VOICE_SECONDS} с — попробуй короче или напиши текстом.`
    );
  }

  await ctx.sendChatAction('typing');
  try {
    const transcript = (await transcribeVoiceMessage(ctx, voice)).slice(0, MAX_USER_MESSAGE_CHARS);
    if (!transcript) {
      inc('voice_empty_total');
      return ctx.reply(
        'Не смог распознать голос — слишком тихо или непонятно. Попробуй ещё раз или напиши текстом.'
      );
    }
    // Показываем пользователю что мы услышали — это полезно при ошибках распознавания.
    await ctx.reply(`🎙 «${transcript}»`);
    await handleUserMessage(ctx, transcript);
  } catch (err) {
    inc('voice_error_total');
    log.error({ err: err.message || err, userId }, 'ошибка транскрипции голосового');
    captureException(err, { userId, scope: 'voice' });
    await ctx.reply(
      'Не получилось распознать голосовое. Попробуй ещё раз или напиши текстом — я понимаю одинаково хорошо.'
    );
  }
});

// === Telegram Payments: pre-checkout + successful_payment ===

// Telegram даёт 10 секунд на ответ pre_checkout_query, иначе платёж не пройдёт.
bot.on('pre_checkout_query', async (ctx) => {
  try {
    await handlePreCheckoutQuery(ctx);
  } catch (err) {
    log.error({ err: err.message || err }, 'pre_checkout_query handler упал');
    try {
      await ctx.answerPreCheckoutQuery(false, 'Внутренняя ошибка, попробуй позже.');
    } catch {
      // already answered or expired
    }
  }
});

bot.on('successful_payment', async (ctx) => {
  try {
    await handleSuccessfulPayment(
      ctx as unknown as import('./payments.js').SuccessfulPaymentContext,
      {
        managerChatId: config.managerChatId,
        telegram: bot.telegram,
      }
    );
  } catch (err) {
    log.error({ err: err.message || err }, 'successful_payment handler упал');
  }
});

// === Жизненный цикл процесса ===

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  log.info({ signal }, 'получен сигнал, останавливаюсь');
  bot.stop(signal);
  await closeRedis();
  await closeDb();
  await shutdownTelemetry();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function registerCommands() {
  // Команды появляются в меню Telegram под полем ввода.
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Начать заново' },
      { command: 'catalog', description: 'Категории' },
      { command: 'featured', description: 'Популярные товары' },
      { command: 'cart', description: 'Моя корзина' },
      { command: 'cancel', description: 'Отменить последний заказ' },
      { command: 'help', description: 'Подсказки' },
      { command: 'clear', description: 'Стереть память диалога' },
      { command: 'version', description: 'Версия бота' },
    ]);
  } catch (err) {
    log.warn({ err: err.message || err }, 'setMyCommands фейл — продолжаем без');
  }
}

// Базовая инициализация: проверки токена + Redis + регистрация команд.
// Один раз перед запуском в любом режиме.
async function prepareBot() {
  try {
    await connectRedis();
  } catch (err) {
    log.error({ err: err.message || err }, 'не удалось подключиться к Redis на старте');
  }
  warmupEmbeddings();

  try {
    const me = await bot.telegram.getMe();
    log.info({ username: me.username, id: me.id }, 'токен Telegram валиден');
  } catch (err) {
    log.fatal({ err: err.message || err }, 'getMe провалился — проверь TELEGRAM_BOT_TOKEN');
    throw err;
  }

  await registerCommands();
}

// Polling-режим: бот сам долбит getUpdates(). Дефолт.
export async function startPolling() {
  await prepareBot();
  await bot.launch();
  log.info('запущен, polling активен');
}

export interface StartWebhookArgs {
  domain: string;
  path: string;
  secretToken?: string;
}

// Webhook-режим: возвращает (req, res) handler, который надо смонтировать на
// внешний HTTP-сервер по пути config.webhookPath. Дополнительно регистрирует
// webhook URL у Telegram через setWebhook().
export async function startWebhook({ domain, path: webhookPath, secretToken }: StartWebhookArgs) {
  await prepareBot();
  const webhookUrl = new URL(webhookPath, domain).toString();
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: secretToken || undefined,
    drop_pending_updates: false,
  });
  log.info({ url: webhookUrl, hasSecret: Boolean(secretToken) }, 'webhook зарегистрирован');
  return bot.webhookCallback(webhookPath, {
    secretToken: secretToken || undefined,
  });
}

export { bot };

// Обратная совместимость: если кто-то импортирует bot.js напрямую без обвязки,
// автозапуск в polling — но только когда WE_ARE_BOOTSTRAPPED не выставлен.
// В проде bootstrap.js сам управляет жизненным циклом.
if (!process.env.BOT_NO_AUTOSTART) {
  startPolling().catch((err) => {
    log.fatal({ err }, 'фатальная ошибка бота');
    process.exit(1);
  });
}
