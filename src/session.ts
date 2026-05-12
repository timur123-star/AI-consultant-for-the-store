// Хранение состояния пользователя в Redis:
//   1) История последних N сообщений диалога — даёт боту "память"
//      ("а есть поменьше?" разрешается в контексте предыдущего ответа).
//   2) Счётчик rate-limit — защита от случайного DoS и перерасхода API-бюджета.
//
// Использует общий клиент из src/redis.js — один коннект на весь процесс.
import { config } from './config.js';
import { connectRedis, getRedisClient, closeRedis } from './redis.js';
import type { ChatMessage } from './types.js';

export { connectRedis, closeRedis };

function historyKey(userId: number | string): string {
  return `chat:history:${userId}`;
}

function rateKey(userId: number | string): string {
  // Точность до минуты — счётчик "ведром".
  const minute = Math.floor(Date.now() / 60_000);
  return `chat:rate:${userId}:${minute}`;
}

export async function getHistory(userId: number | string): Promise<ChatMessage[]> {
  await connectRedis();
  const client = getRedisClient();
  const raw = await client.lRange(historyKey(userId), 0, -1);
  return raw.map((s) => JSON.parse(s) as ChatMessage);
}

export async function appendHistory(
  userId: number | string,
  userText: string,
  botText: string
): Promise<void> {
  await connectRedis();
  const client = getRedisClient();
  const key = historyKey(userId);
  const tx = client.multi();
  tx.rPush(key, JSON.stringify({ role: 'user', content: userText }));
  tx.rPush(key, JSON.stringify({ role: 'assistant', content: botText }));
  // Держим только последние historyLimit ПАР сообщений = historyLimit*2 элементов.
  tx.lTrim(key, -config.historyLimit * 2, -1);
  tx.expire(key, config.historyTtlSeconds);
  await tx.exec();
}

export async function clearHistory(userId: number | string): Promise<void> {
  await connectRedis();
  const client = getRedisClient();
  await client.del(historyKey(userId));
}

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
}

// Возвращает { allowed, remaining } и атомарно увеличивает счётчик.
export async function checkRateLimit(userId: number | string): Promise<RateLimitCheck> {
  await connectRedis();
  const client = getRedisClient();
  const key = rateKey(userId);
  const tx = client.multi();
  tx.incr(key);
  tx.expire(key, 65);
  const [count] = await tx.exec();
  const used = Number(count);
  const remaining = Math.max(0, config.rateLimitPerMinute - used);
  return { allowed: used <= config.rateLimitPerMinute, remaining };
}
