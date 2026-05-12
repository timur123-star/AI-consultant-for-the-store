// E2E-симуляция Telegram-клиента.
//
// Идея: вместо мокания каждого handler'а — поднимаем настоящий Telegraf
// `bot` из src/bot.ts, перехватываем единственную точку выхода
// (`bot.telegram.callApi`), и кормим в `bot.handleUpdate()` фейковые
// Telegram-апдейты. Это даёт полную проверку маршрутизации + middleware
// без сети и без работающего Telegram API.
//
// Все side-effect'ы (Postgres, Redis, embeddings, LLM, voice, payments)
// замоканы через `vi.mock` до импорта `bot`.

import { beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';
import type { Update } from 'telegraf/types';

// ---- 1. env-переменные ставим ДО любого import из src/config.ts ----
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '0:e2e';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_e2e';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost:1/x';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:1';
process.env.BOT_NO_AUTOSTART = '1';

// ---- 2. Моки всех side-effect'ов ----

vi.mock('../src/db.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  closeDb: vi.fn().mockResolvedValue(undefined),
  pool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
  toPgVector: (a: number[]) => `[${a.join(',')}]`,
}));

vi.mock('../src/redis.js', () => ({
  getRedis: vi.fn(),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  closeRedis: vi.fn().mockResolvedValue(undefined),
  pingRedis: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/session.js', () => ({
  connectRedis: vi.fn().mockResolvedValue(undefined),
  closeRedis: vi.fn().mockResolvedValue(undefined),
  getHistory: vi.fn().mockResolvedValue([]),
  appendHistory: vi.fn().mockResolvedValue(undefined),
  clearHistory: vi.fn().mockResolvedValue(undefined),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 19 }),
}));

vi.mock('../src/cart.js', () => ({
  addToCart: vi.fn().mockResolvedValue('ok'),
  removeFromCart: vi.fn().mockResolvedValue('ok'),
  getCartItems: vi.fn().mockResolvedValue([]),
  clearCart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/carousel.js', () => ({
  createCarousel: vi.fn().mockResolvedValue('car-1'),
  getCarousel: vi.fn().mockResolvedValue(null),
}));

const findProductsMock = vi.fn().mockResolvedValue([]);
const getFeaturedProductsMock = vi.fn().mockResolvedValue([]);
vi.mock('../src/rag.js', () => ({
  findProducts: findProductsMock,
  formatProductsForPrompt: () => '',
  getFeaturedProducts: getFeaturedProductsMock,
  getProductById: vi.fn().mockResolvedValue(null),
  textSearchProducts: vi.fn().mockResolvedValue([]),
}));

const chatCompleteMock = vi.fn().mockResolvedValue('Здравствуй! Я тестовый ответ от LLM.');
vi.mock('../src/llm.js', () => ({
  chatComplete: chatCompleteMock,
}));

vi.mock('../src/embeddings.js', () => ({
  warmupEmbeddings: vi.fn(),
  embed: vi.fn().mockResolvedValue(new Array(384).fill(0)),
}));

vi.mock('../src/logger.js', () => ({
  logConversation: vi.fn().mockResolvedValue(undefined),
  recordOrder: vi.fn().mockResolvedValue({ id: 1, user_id: 1, product_id: 1, status: 'new' }),
  getStats: vi.fn().mockResolvedValue({
    conversations: { total: 0, last_24h: 0, unique_users: 0 },
    orders: { total: 0, last_24h: 0 },
    topProducts: [],
  }),
  updateOrderStatus: vi.fn().mockResolvedValue(null),
  getRecentOrders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../src/voice.js', () => ({
  transcribeVoiceMessage: vi.fn().mockResolvedValue('текст из голоса'),
  MAX_VOICE_SECONDS: 60,
}));

vi.mock('../src/payments.js', () => ({
  isPaymentsEnabled: () => false,
  sendInvoiceForCart: vi.fn(),
  handlePreCheckoutQuery: vi.fn(),
  handleSuccessfulPayment: vi.fn(),
}));

// ---- 3. Импортируем bot после моков ----
// (динамический импорт, чтобы env гарантированно был выставлен)
type BotModule = typeof import('../src/bot.js');
let mod: BotModule;
type CallApi = (method: string, payload: Record<string, unknown>) => Promise<unknown>;
type BotInstance = BotModule['bot'];
let bot: BotInstance;
const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];

beforeAll(async () => {
  mod = await import('../src/bot.js');
  bot = mod.bot;

  const fakeCallApi: CallApi = async (method, payload) => {
    apiCalls.push({ method, payload: payload || {} });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return {
        message_id: apiCalls.length,
        date: 0,
        chat: (payload && payload.chat_id) || {},
        text: (payload && payload.text) || '',
      } as unknown;
    }
    if (method === 'getMe') {
      return {
        id: 1,
        is_bot: true,
        username: 'e2e_bot',
        first_name: 'E2E',
      };
    }
    if (method === 'sendChatAction') return true;
    if (method === 'answerCallbackQuery') return true;
    return {};
  };

  // Монки-патчим на prototype-уровне: telegraf v4 хранит callApi на
  // ApiClient.prototype, и instance-shadow не всегда работает из-за bind.
  const proto = Object.getPrototypeOf(bot.telegram) as Record<string, unknown>;
  (proto as { callApi: CallApi }).callApi = fakeCallApi;
  (bot.telegram as unknown as { callApi: CallApi }).callApi = fakeCallApi;
});

beforeEach(() => {
  apiCalls.length = 0;
});

function fakeMessageUpdate(text: string, userId = 100): Update {
  return {
    update_id: Date.now() + Math.floor(Math.random() * 1000),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Test' },
      from: { id: userId, is_bot: false, first_name: 'Test', language_code: 'ru' },
      text,
      entities:
        text.startsWith('/') && text.length > 1
          ? [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }]
          : undefined,
    },
  } as unknown as Update;
}

function lastSentText(): string | undefined {
  for (let i = apiCalls.length - 1; i >= 0; i--) {
    if (apiCalls[i].method === 'sendMessage') {
      return String(apiCalls[i].payload.text || '');
    }
  }
  return undefined;
}

function allSentTexts(): string[] {
  return apiCalls
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload.text || ''));
}

describe('Telegram bot E2E', () => {
  it('/ping → "pong"', async () => {
    await bot.handleUpdate(fakeMessageUpdate('/ping'));
    expect(lastSentText()).toBe('pong');
  });

  it('/start → приветствие с упоминанием магазина', async () => {
    await bot.handleUpdate(fakeMessageUpdate('/start'));
    const text = lastSentText() || '';
    expect(text).toMatch(/КожаМастер|консультант/);
  });

  it('/help → инструкция с примерами', async () => {
    await bot.handleUpdate(fakeMessageUpdate('/help'));
    const text = lastSentText() || '';
    expect(text.length).toBeGreaterThan(20);
  });

  it('/version → выдаёт строку с версией', async () => {
    await bot.handleUpdate(fakeMessageUpdate('/version'));
    const text = lastSentText() || '';
    expect(text).toMatch(/версия|version/i);
  });

  it('обычный текст → LLM вызывается, ответ отправляется', async () => {
    findProductsMock.mockResolvedValueOnce([
      {
        id: 1,
        sku: 'bag-1',
        name: 'Сумка тестовая',
        description: 'тест',
        price: 5000,
        category: 'bags',
        in_stock: true,
        image_url: null,
        tags: [],
      },
    ]);
    chatCompleteMock.mockResolvedValueOnce('Рекомендую сумку!');
    await bot.handleUpdate(fakeMessageUpdate('нужна сумка'));
    expect(chatCompleteMock).toHaveBeenCalled();
    expect(allSentTexts()).toContain('Рекомендую сумку!');
  });

  it('обычный текст без матча и без истории → FALLBACK_REPLY, LLM не вызывается', async () => {
    findProductsMock.mockResolvedValueOnce([]);
    getFeaturedProductsMock.mockResolvedValueOnce([]);
    const before = chatCompleteMock.mock.calls.length;
    await bot.handleUpdate(fakeMessageUpdate('абракадабра'));
    expect(chatCompleteMock.mock.calls.length).toBe(before);
    const text = lastSentText() || '';
    expect(text).toMatch(/менеджер|каталог|переформулировать/);
  });

  it('юзер за один update не вызывает sendMessage два раза с пустым текстом', async () => {
    await bot.handleUpdate(fakeMessageUpdate('/ping'));
    const emptyReplies = apiCalls
      .filter((c) => c.method === 'sendMessage')
      .filter((c) => !String(c.payload.text || '').trim());
    expect(emptyReplies).toHaveLength(0);
  });
});
