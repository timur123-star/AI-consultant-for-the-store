// Единый Redis-клиент на весь процесс.
// До этого session.js / cart.js / carousel.js держали по своему клиенту —
// три коннекта к одному и тому же Redis, что лишний расход и сложнее в shutdown.
//
// Здесь делаем один lazy-singleton с переподключением и graceful close.
import { createClient, type RedisClientType } from 'redis';
import { config } from './config.js';
import { child } from './log.js';

const log = child('redis');

function safeRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    const auth = u.password ? `${u.username || 'default'}:***@` : '';
    return `${u.protocol}//${auth}${u.hostname}:${u.port || '6379'}`;
  } catch {
    return '(невалидный URL)';
  }
}

let client: RedisClientType | null = null;
let connectPromise: Promise<void> | null = null;

function buildClient(): RedisClientType {
  const c = createClient({
    url: config.redisUrl,
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: (retries) =>
        retries > 5 ? new Error('redis недоступен') : Math.min(retries * 200, 2000),
    },
  });
  c.on('error', (err: { message?: string }) =>
    log.error({ err: err.message || err }, 'redis client error')
  );
  return c as RedisClientType;
}

export function getRedisClient(): RedisClientType {
  if (!client) client = buildClient();
  return client;
}

export function connectRedis(): Promise<void> {
  if (!connectPromise) {
    const c = getRedisClient();
    if (c.isOpen) {
      connectPromise = Promise.resolve();
      return connectPromise;
    }
    log.info({ url: safeRedisUrl(config.redisUrl) }, 'подключаюсь к Redis');
    connectPromise = c.connect().then(
      () => {
        log.info('подключение установлено');
      },
      (err) => {
        connectPromise = null;
        throw err;
      }
    );
  }
  return connectPromise;
}

export async function closeRedis(): Promise<void> {
  if (client && client.isOpen) {
    await client.quit();
  }
  client = null;
  connectPromise = null;
}

// Простая проверка готовности (ping). Используется в /ready endpoint.
export async function pingRedis(): Promise<boolean> {
  await connectRedis();
  const c = getRedisClient();
  const res = await c.ping();
  return res === 'PONG';
}
