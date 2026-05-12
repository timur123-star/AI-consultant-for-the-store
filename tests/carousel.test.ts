import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockRedisModule } from './helpers/redis-mock.js';

const mockModule = createMockRedisModule();
vi.mock('redis', () => mockModule);

const { createCarousel, getCarousel } = await import('../src/carousel.js');
const { closeRedis } = await import('../src/redis.js');

beforeEach(async () => {
  await closeRedis();
});

describe('carousel', () => {
  it('createCarousel возвращает 16-символьный hex токен', async () => {
    const token = await createCarousel([1, 2, 3]);
    expect(token).toMatch(/^[a-f0-9]{16}$/);
  });

  it('getCarousel читает сохранённые ids и title', async () => {
    const token = await createCarousel([10, 20, 30], { title: 'Новинки' });
    const car = await getCarousel(token);
    expect(car).not.toBeNull();
    expect(car!.ids).toEqual([10, 20, 30]);
    expect(car!.title).toBe('Новинки');
  });

  it('getCarousel возвращает null для несуществующего токена', async () => {
    const car = await getCarousel('deadbeefdeadbeef');
    expect(car).toBeNull();
  });

  it('createCarousel бросает на пустом списке', async () => {
    await expect(createCarousel([])).rejects.toThrow(/пуст/);
  });

  it('createCarousel фильтрует невалидные id', async () => {
    const token = await createCarousel([1, 'abc', NaN, 2] as unknown as number[]);
    const car = await getCarousel(token);
    expect(car!.ids).toEqual([1, 2]);
  });

  it('title по умолчанию — пустая строка', async () => {
    const token = await createCarousel([1]);
    const car = await getCarousel(token);
    expect(car!.title).toBe('');
  });
});
