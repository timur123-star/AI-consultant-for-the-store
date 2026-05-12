import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRedisModule } from './helpers/redis-mock.js';

const mockModule = createMockRedisModule();
vi.mock('redis', () => mockModule);

const { addToCart, removeFromCart, getCartItems, clearCart, CART_MAX_ITEMS } =
  await import('../src/cart.js');
const { closeRedis } = await import('../src/redis.js');

beforeEach(async () => {
  await closeRedis();
});

describe('cart', () => {
  it('addToCart возвращает added=true для нового товара', async () => {
    const res = await addToCart(1, 101);
    expect(res.added).toBe(true);
    expect(res.size).toBe(1);
    expect(res.limit).toBe(CART_MAX_ITEMS);
  });

  it('повторное добавление того же товара: added=false, size не растёт', async () => {
    await addToCart(2, 101);
    const second = await addToCart(2, 101);
    expect(second.added).toBe(false);
    expect(second.size).toBe(1);
  });

  it('getCartItems возвращает массив чисел', async () => {
    await addToCart(3, 101);
    await addToCart(3, 102);
    const items = await getCartItems(3);
    expect(items.sort()).toEqual([101, 102]);
    items.forEach((id) => expect(typeof id).toBe('number'));
  });

  it('removeFromCart убирает товар из корзины', async () => {
    await addToCart(4, 101);
    await addToCart(4, 102);
    await removeFromCart(4, 101);
    const items = await getCartItems(4);
    expect(items).toEqual([102]);
  });

  it('clearCart полностью очищает корзину', async () => {
    await addToCart(5, 101);
    await clearCart(5);
    expect(await getCartItems(5)).toEqual([]);
  });

  it('MAX_ITEMS реально enforce-ится: 21-й товар отвергается', async () => {
    const userId = 999;
    for (let i = 0; i < CART_MAX_ITEMS; i += 1) {
      const r = await addToCart(userId, 1000 + i);
      expect(r.added).toBe(true);
    }
    const overflow = await addToCart(userId, 9999);
    expect(overflow.added).toBe(false);
    expect(overflow.size).toBe(CART_MAX_ITEMS);
    expect(overflow.limit).toBe(CART_MAX_ITEMS);
    const items = await getCartItems(userId);
    expect(items).toHaveLength(CART_MAX_ITEMS);
    expect(items).not.toContain(9999);
  });

  it('повторное добавление уже находящегося в полной корзине товара разрешено', async () => {
    const userId = 998;
    for (let i = 0; i < CART_MAX_ITEMS; i += 1) {
      await addToCart(userId, 2000 + i);
    }
    // 2000 уже в корзине, повторное добавление не должно ломаться о лимит.
    const r = await addToCart(userId, 2000);
    expect(r.added).toBe(false); // sAdd вернул 0
    expect(r.size).toBe(CART_MAX_ITEMS);
  });
});
