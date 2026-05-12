// Корзина пользователя в Redis: множество product_id, которые он отложил.
// TTL 24 часа, MAX_ITEMS реально enforced — повторное добавление сверх лимита
// возвращает { added: false }.
import { connectRedis, getRedisClient } from './redis.js';

const TTL_SECONDS = 60 * 60 * 24;
const MAX_ITEMS = 20;

function key(userId: number | string): string {
  return `cart:${userId}`;
}

export interface AddToCartResult {
  added: boolean;
  size: number;
  limit: number;
}

// Возвращает { added, size, limit }.
//  - added=true когда товар реально добавлен в корзину
//  - added=false когда лимит уже достигнут (товара ещё не было)
//    или товар уже был в корзине (Redis SADD вернул 0, но size актуальный)
export async function addToCart(
  userId: number | string,
  productId: number
): Promise<AddToCartResult> {
  await connectRedis();
  const client = getRedisClient();
  const k = key(userId);
  const currentSize = await client.sCard(k);
  const isMember = await client.sIsMember(k, String(productId));
  if (!isMember && currentSize >= MAX_ITEMS) {
    return { added: false, size: currentSize, limit: MAX_ITEMS };
  }
  const wasAdded = await client.sAdd(k, String(productId));
  await client.expire(k, TTL_SECONDS);
  const size = await client.sCard(k);
  return { added: wasAdded > 0, size, limit: MAX_ITEMS };
}

export async function removeFromCart(userId: number | string, productId: number): Promise<void> {
  await connectRedis();
  const client = getRedisClient();
  await client.sRem(key(userId), String(productId));
}

export async function getCartItems(userId: number | string): Promise<number[]> {
  await connectRedis();
  const client = getRedisClient();
  const members = await client.sMembers(key(userId));
  return members.map((s) => Number(s)).filter((n) => Number.isFinite(n));
}

export async function clearCart(userId: number | string): Promise<void> {
  await connectRedis();
  const client = getRedisClient();
  await client.del(key(userId));
}

export { TTL_SECONDS as CART_TTL_SECONDS, MAX_ITEMS as CART_MAX_ITEMS };
