import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRedisModule } from './helpers/redis-mock.js';

const mockModule = createMockRedisModule();
vi.mock('redis', () => mockModule);

const { cacheKey, encodeVector, decodeVector, getCached, setCached, flushCache } =
  await import('../src/embedding-cache.js');
const { connectRedis, closeRedis } = await import('../src/redis.js');

beforeEach(async () => {
  await closeRedis();
  await connectRedis();
  await flushCache();
});

describe('cacheKey', () => {
  it('детерминирован для одного и того же текста', () => {
    const a = cacheKey('query: тест');
    const b = cacheKey('query: тест');
    expect(a).toBe(b);
    expect(a).toMatch(/^emb:v1:/);
  });

  it('разный для разных текстов', () => {
    expect(cacheKey('query: a')).not.toBe(cacheKey('query: b'));
  });

  it('разный для query: vs passage:', () => {
    expect(cacheKey('query: тест')).not.toBe(cacheKey('passage: тест'));
  });
});

describe('encodeVector/decodeVector', () => {
  it('roundtrip сохраняет значения с float32-точностью', () => {
    const vec = [0.1, -0.5, 1.2345, 0, 1e-6];
    const encoded = encodeVector(vec);
    const decoded = decodeVector(encoded);
    expect(decoded.length).toBe(vec.length);
    for (let i = 0; i < vec.length; i += 1) {
      expect(decoded[i]).toBeCloseTo(vec[i], 5);
    }
  });

  it('encoded — это base64', () => {
    const encoded = encodeVector([0.1, 0.2, 0.3]);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('getCached/setCached', () => {
  it('после set — get возвращает тот же вектор', async () => {
    const vec = [0.5, -0.3, 0.1];
    await setCached('query: hello', vec);
    const got = await getCached('query: hello');
    expect(got).not.toBeNull();
    for (let i = 0; i < vec.length; i += 1) {
      expect(got![i]).toBeCloseTo(vec[i], 5);
    }
  });

  it('miss возвращает null', async () => {
    const got = await getCached('query: never-cached');
    expect(got).toBeNull();
  });

  it('flushCache очищает все ключи', async () => {
    await setCached('query: a', [1, 2, 3]);
    await setCached('query: b', [4, 5, 6]);
    await flushCache();
    expect(await getCached('query: a')).toBeNull();
    expect(await getCached('query: b')).toBeNull();
  });
});
