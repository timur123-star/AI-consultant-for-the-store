import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Перезагружаем модуль config при изменении process.env. Используем
// vi.resetModules() — это сбрасывает кеш модулей vitest и при следующем
// импорте даёт свежую копию config с актуальным process.env.
async function loadConfig() {
  vi.resetModules();
  const mod = await import('../src/config.js');
  return mod.config;
}

const ORIGINAL_ENV = { ...process.env };
const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  GROQ_API_KEY: 'gsk_test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ...REQUIRED_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('config', () => {
  it('читает обязательные переменные окружения', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'custom-token';
    process.env.GROQ_API_KEY = 'gsk_custom';
    const config = await loadConfig();
    expect(config.telegramBotToken).toBe('custom-token');
    expect(config.groqApiKey).toBe('gsk_custom');
  });

  it('подставляет дефолтные значения для опциональных переменных', async () => {
    const config = await loadConfig();
    expect(config.historyLimit).toBeGreaterThan(0);
    expect(config.rateLimitPerMinute).toBeGreaterThan(0);
    expect(config.embeddingModel).toBeTruthy();
    expect(config.groqModel).toBeTruthy();
    expect(config.embeddingDim).toBe(384);
  });

  it('rateLimitPerMinute читается из env как число', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '42';
    const config = await loadConfig();
    expect(config.rateLimitPerMinute).toBe(42);
  });

  it('бросает понятную ошибку если обязательной переменной нет', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(loadConfig()).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
