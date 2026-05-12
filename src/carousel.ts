// Carousel — состояние "просмотра списка товаров" в одном сообщении Telegram.
// Хранит массив product_id в Redis под коротким токеном (16 hex символов),
// чтобы поместиться в 64-байтный лимит callback_data вместе с навигацией.
//
// Используется для:
//   - /catalog (товары в категории)
//   - /featured (топ-6 популярных)
//   - текстового поиска (top-N результатов)
//
// TTL 1 час — пользователь не будет возвращаться к старой карусели позже.
import { randomBytes } from 'node:crypto';
import { connectRedis, getRedisClient } from './redis.js';
import { child } from './log.js';

const log = child('carousel');

const TTL_SECONDS = 60 * 60; // 1 час
const KEY_PREFIX = 'carousel:';

function genToken(): string {
  return randomBytes(8).toString('hex'); // 16 символов — достаточно уникально и компактно
}

export interface CarouselState {
  ids: number[];
  title: string;
}

// Сохраняет массив product_id под новым токеном. Опционально принимает title —
// заголовок, который будет показан над карточкой («Найдено по запросу: …»).
export async function createCarousel(
  productIds: number[],
  { title = '' }: { title?: string } = {}
): Promise<string> {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new Error('createCarousel: список товаров пуст');
  }
  await connectRedis();
  const client = getRedisClient();
  const token = genToken();
  const payload = JSON.stringify({
    ids: productIds.map(Number).filter(Number.isFinite),
    title,
  });
  await client.set(KEY_PREFIX + token, payload, { EX: TTL_SECONDS });
  return token;
}

// Возвращает { ids, title } или null, если карусель устарела.
export async function getCarousel(token: string): Promise<CarouselState | null> {
  await connectRedis();
  const client = getRedisClient();
  const raw = await client.get(KEY_PREFIX + token);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.ids)) return null;
    // Освежаем TTL — каждое переключение «продлевает» сессию.
    await client.expire(KEY_PREFIX + token, TTL_SECONDS);
    return { ids: obj.ids, title: obj.title || '' };
  } catch (err) {
    log.warn({ err: err.message || err, token }, 'не смог распарсить carousel payload');
    return null;
  }
}

export { TTL_SECONDS as CAROUSEL_TTL_SECONDS };
