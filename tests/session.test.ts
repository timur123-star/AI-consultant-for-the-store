import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRedisModule } from './helpers/redis-mock.js';

const mockModule = createMockRedisModule();
vi.mock('redis', () => mockModule);

const { getHistory, appendHistory, clearHistory, checkRateLimit } =
  await import('../src/session.js');
const { closeRedis } = await import('../src/redis.js');

beforeEach(async () => {
  await closeRedis();
});

describe('session.history', () => {
  it('appendHistory + getHistory возвращают пары user/assistant', async () => {
    await appendHistory(1, 'привет', 'и тебе привет');
    const hist = await getHistory(1);
    expect(hist).toHaveLength(2);
    expect(hist[0]).toEqual({ role: 'user', content: 'привет' });
    expect(hist[1]).toEqual({ role: 'assistant', content: 'и тебе привет' });
  });

  it('clearHistory обнуляет историю', async () => {
    await appendHistory(2, 'a', 'b');
    await clearHistory(2);
    expect(await getHistory(2)).toEqual([]);
  });

  it('история обрезается до historyLimit пар', async () => {
    // historyLimit = 10 пар — после 12 запушенных пар останутся последние 10.
    for (let i = 0; i < 12; i += 1) {
      await appendHistory(3, `msg${i}`, `reply${i}`);
    }
    const hist = await getHistory(3);
    expect(hist).toHaveLength(20);
    expect(hist[0].content).toBe('msg2');
    expect(hist[hist.length - 1].content).toBe('reply11');
  });
});

describe('session.rateLimit', () => {
  it('первый вызов allowed=true, remaining уменьшается', async () => {
    const first = await checkRateLimit(100);
    expect(first.allowed).toBe(true);
    const second = await checkRateLimit(100);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBeLessThan(first.remaining);
  });

  it('после превышения лимита allowed=false', async () => {
    // RATE_LIMIT_PER_MINUTE по умолчанию 20.
    for (let i = 0; i < 20; i += 1) {
      const r = await checkRateLimit(101);
      expect(r.allowed).toBe(true);
    }
    const over = await checkRateLimit(101);
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });
});
