import 'dotenv/config';

export type BotMode = 'polling' | 'webhook';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана переменная окружения ${name}. Скопируй .env.example в .env и заполни.`
    );
  }
  return value;
}

function optional<T extends string | null>(name: string, fallback: T): string | T {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function botMode(): BotMode {
  const m = (optional('BOT_MODE', 'polling') as string).toLowerCase();
  if (m !== 'polling' && m !== 'webhook') {
    throw new Error(`BOT_MODE должен быть 'polling' или 'webhook', получено: ${m}`);
  }
  return m;
}

export interface AppConfig {
  telegramBotToken: string;
  managerChatId: string | null;
  adminUserId: string | null;
  groqApiKey: string;
  groqModel: string;
  databaseUrl: string;
  redisUrl: string;
  rateLimitPerMinute: number;
  embeddingModel: string;
  embeddingDim: number;
  historyLimit: number;
  historyTtlSeconds: number;
  botMode: BotMode;
  webhookDomain: string;
  webhookPath: string;
  webhookSecretToken: string;
  paymentProviderToken: string;
  paymentCurrency: string;
}

export const config: AppConfig = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  managerChatId: optional('MANAGER_CHAT_ID', null),
  adminUserId: optional('ADMIN_USER_ID', null),
  groqApiKey: required('GROQ_API_KEY'),
  groqModel: optional('GROQ_MODEL', 'llama-3.3-70b-versatile'),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  rateLimitPerMinute: Number(optional('RATE_LIMIT_PER_MINUTE', '20')),
  embeddingModel: optional('EMBEDDING_MODEL', 'Xenova/multilingual-e5-small'),
  embeddingDim: 384,
  historyLimit: 10,
  historyTtlSeconds: 60 * 60 * 24,
  // Режим бота: 'polling' (дефолт) или 'webhook'.
  // Для webhook обязателен WEBHOOK_DOMAIN (https://your.host).
  botMode: botMode(),
  webhookDomain: optional('WEBHOOK_DOMAIN', ''),
  webhookPath: optional('WEBHOOK_PATH', '/telegram/webhook'),
  // Опциональный секрет — Telegram пришлёт его в заголовке
  // X-Telegram-Bot-Api-Secret-Token. Защищает webhook от чужого вызова.
  webhookSecretToken: optional('WEBHOOK_SECRET_TOKEN', ''),
  // Telegram Payments. Без токена payments-флоу отключён, остаётся ручной checkout.
  // Получить токен: @BotFather → /mybots → Payments → выбрать провайдера
  // (Stripe TEST, ЮKassa, Сбер, etc.).
  paymentProviderToken: optional('PAYMENT_PROVIDER_TOKEN', ''),
  paymentCurrency: optional('PAYMENT_CURRENCY', 'RUB'),
};
