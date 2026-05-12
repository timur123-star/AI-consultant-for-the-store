// Кэш embedding-векторов в Redis. Ключ — стабильный хэш входного текста (с
// префиксом query/passage и именем модели), значение — Float32 вектор в base64.
// Зачем: один и тот же поисковый запрос повторяется десятки раз в день, а каждый
// `embed()` стоит ~30-80 мс CPU. Кэш сжимает p95 latency RAG-пайплайна в разы.
import { createHash } from 'node:crypto';
import { connectRedis, getRedisClient } from './redis.js';
import { config } from './config.js';
import { child } from './log.js';
import { inc } from './metrics.js';

const log = child('emb-cache');

const KEY_PREFIX = 'emb:v1';
// 7 дней по умолчанию. Embedding модель меняется редко — TTL можно держать долгим.
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

function ttlSeconds(): number {
  const env = process.env.EMBEDDING_CACHE_TTL_SECONDS;
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

// Стабильный ключ: модель + первые 32 символа sha256 префиксированного текста.
// Хэш короткий (16 байт), но коллизий для нашего объёма нет.
export function cacheKey(prefixedText: string, model: string = config.embeddingModel): string {
  const h = createHash('sha256').update(prefixedText).digest('hex').slice(0, 32);
  return `${KEY_PREFIX}:${model}:${h}`;
}

// Сериализация в base64. Длина 384*4 = 1536 байт → ~2 КБ base64. Дёшево.
export function encodeVector(vector: ArrayLike<number>): string {
  const buf = Buffer.from(new Float32Array(vector).buffer);
  return buf.toString('base64');
}

export function decodeVector(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64');
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(view);
}

// Если Redis недоступен, кэш graceful no-op — embed() просто всегда считает заново.
async function safeGet(key: string): Promise<string | null> {
  try {
    await connectRedis();
    return await getRedisClient().get(key);
  } catch (err) {
    log.warn({ err: err.message || err }, 'cache get failed; fallback to compute');
    return null;
  }
}

async function safeSet(key: string, value: string, ttl: number): Promise<void> {
  try {
    await connectRedis();
    await getRedisClient().set(key, value, { EX: ttl });
  } catch (err) {
    log.warn({ err: err.message || err }, 'cache set failed; ignoring');
  }
}

export async function getCached(prefixedText: string): Promise<number[] | null> {
  const key = cacheKey(prefixedText);
  const value = await safeGet(key);
  if (value) {
    inc('embedding_cache_hit_total');
    return decodeVector(value);
  }
  inc('embedding_cache_miss_total');
  return null;
}

export async function setCached(prefixedText: string, vector: ArrayLike<number>): Promise<void> {
  const key = cacheKey(prefixedText);
  await safeSet(key, encodeVector(vector), ttlSeconds());
}

// Только для тестов. Не подключается, если клиент не открыт.
export async function flushCache(): Promise<void> {
  try {
    const c = getRedisClient();
    if (!c.isOpen) return;
    // KEYS блокирующая, но в тестах база пустая — это ок. В проде используем TTL.
    const keys = await c.keys(`${KEY_PREFIX}:*`);
    if (keys.length) await c.del(keys);
  } catch (err) {
    log.warn({ err: err.message || err }, 'flush cache failed');
  }
}
