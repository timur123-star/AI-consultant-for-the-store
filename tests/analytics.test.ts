import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем db.query — analytics.ts строит реальный SQL, но в тестах подсовываем
// фейковые row sets, чтобы проверить агрегацию/рендеринг без Postgres.
const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { buildAnalyticsSnapshot, renderAnalyticsHtml } from '../src/analytics.js';

function nextQueryResolves(rows: unknown[]): void {
  queryMock.mockResolvedValueOnce({ rows });
}

function setupAllQueries(): void {
  // Порядок вызовов внутри buildAnalyticsSnapshot:
  //   1) totals
  //   2) daily
  //   3) topQueries
  //   4) variantStats
  //   5) topCategories
  //   6) topSkus
  nextQueryResolves([
    {
      conversations_total: 100,
      conversations_24h: 20,
      conversations_7d: 60,
      unique_users_total: 30,
      unique_users_24h: 8,
      orders_total: 12,
      orders_24h: 3,
      orders_paid_total: 7,
      fallback_total: 15,
    },
  ]);
  nextQueryResolves([
    { day: '2026-05-12', conversations: 20, unique_users: 8 },
    { day: '2026-05-11', conversations: 15, unique_users: 6 },
  ]);
  nextQueryResolves([
    { user_text: 'сумка из кожи', count: 10 },
    { user_text: 'перчатки на зиму', count: 6 },
  ]);
  nextQueryResolves([
    {
      variant: 'baseline',
      count: 40,
      avg_user_text_length: '42.5',
      avg_bot_text_length: '320.0',
    },
    {
      variant: 'sales_focused',
      count: 20,
      avg_user_text_length: '38.2',
      avg_bot_text_length: '410.1',
    },
  ]);
  nextQueryResolves([
    { category: 'bags', matches: 25 },
    { category: 'gloves', matches: 12 },
  ]);
  nextQueryResolves([
    { user_text: 'bag-001', count: 8 },
    { user_text: 'glv-014', count: 5 },
  ]);
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('buildAnalyticsSnapshot', () => {
  it('агрегирует все секции в единый snapshot', async () => {
    setupAllQueries();
    const snap = await buildAnalyticsSnapshot();

    expect(snap.totals.conversations_total).toBe(100);
    expect(snap.totals.fallback_rate).toBeCloseTo(0.15, 3);
    expect(snap.totals.unique_users_24h).toBe(8);

    expect(snap.daily).toHaveLength(2);
    expect(snap.daily[0]).toEqual({
      day: '2026-05-12',
      conversations: 20,
      unique_users: 8,
    });

    expect(snap.top_queries_7d).toHaveLength(2);
    expect(snap.top_queries_7d[0]).toEqual({ user_text: 'сумка из кожи', count: 10 });

    expect(snap.prompt_variants).toHaveLength(2);
    expect(snap.prompt_variants[0].variant).toBe('baseline');
    expect(snap.prompt_variants[0].count).toBe(40);
    expect(snap.prompt_variants[0].avg_user_text_length).toBeCloseTo(42.5, 1);

    expect(snap.top_categories_7d[0]).toEqual({ category: 'bags', matches: 25 });
    expect(snap.top_skus_7d[0]).toEqual({ user_text: 'bag-001', count: 8 });
    expect(snap.generated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('возвращает пустые тоталы при сбое первого запроса', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    // Остальные 5 запросов тоже должны быть стрелаемы пустыми
    for (let i = 0; i < 5; i++) queryMock.mockRejectedValueOnce(new Error('db down'));
    const snap = await buildAnalyticsSnapshot();
    expect(snap.totals.conversations_total).toBe(0);
    expect(snap.totals.fallback_rate).toBe(0);
    expect(snap.daily).toEqual([]);
    expect(snap.top_queries_7d).toEqual([]);
    expect(snap.prompt_variants).toEqual([]);
  });

  it('fallback_rate = 0 при пустой таблице', async () => {
    nextQueryResolves([
      {
        conversations_total: 0,
        conversations_24h: 0,
        conversations_7d: 0,
        unique_users_total: 0,
        unique_users_24h: 0,
        orders_total: 0,
        orders_24h: 0,
        orders_paid_total: 0,
        fallback_total: 0,
      },
    ]);
    for (let i = 0; i < 5; i++) nextQueryResolves([]);
    const snap = await buildAnalyticsSnapshot();
    expect(snap.totals.fallback_rate).toBe(0);
  });
});

describe('renderAnalyticsHtml', () => {
  it('производит HTML с навигацией и всеми секциями', async () => {
    setupAllQueries();
    const snap = await buildAnalyticsSnapshot();
    const html = renderAnalyticsHtml(snap);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Analytics — AI consultant for the store');
    expect(html).toContain('/docs');
    expect(html).toContain('/metrics');
    expect(html).toContain('/analytics.json');
    // Тоталы попадают на карточки
    expect(html).toContain('100'); // conversations_total
    expect(html).toContain('15.0%'); // fallback_rate
    // Топ запросов отрендерены
    expect(html).toContain('сумка из кожи');
    expect(html).toContain('перчатки на зиму');
    // Variant таблица
    expect(html).toContain('baseline');
    expect(html).toContain('sales_focused');
    // Категории и SKU
    expect(html).toContain('bags');
    expect(html).toContain('bag-001');
  });

  it('экранирует HTML-метасимволы в user_text', async () => {
    nextQueryResolves([
      {
        conversations_total: 0,
        conversations_24h: 0,
        conversations_7d: 0,
        unique_users_total: 0,
        unique_users_24h: 0,
        orders_total: 0,
        orders_24h: 0,
        orders_paid_total: 0,
        fallback_total: 0,
      },
    ]);
    nextQueryResolves([]);
    nextQueryResolves([{ user_text: '<script>alert(1)</script>', count: 99 }]);
    nextQueryResolves([]);
    nextQueryResolves([]);
    nextQueryResolves([]);

    const snap = await buildAnalyticsSnapshot();
    const html = renderAnalyticsHtml(snap);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('graceful empty-state когда нет данных', async () => {
    nextQueryResolves([
      {
        conversations_total: 0,
        conversations_24h: 0,
        conversations_7d: 0,
        unique_users_total: 0,
        unique_users_24h: 0,
        orders_total: 0,
        orders_24h: 0,
        orders_paid_total: 0,
        fallback_total: 0,
      },
    ]);
    for (let i = 0; i < 5; i++) nextQueryResolves([]);
    const snap = await buildAnalyticsSnapshot();
    const html = renderAnalyticsHtml(snap);
    expect(html).toMatch(/нет данных|за 7 дней нет/);
  });
});
