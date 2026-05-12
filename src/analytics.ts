// Analytics dashboard — read-only снимок диалогов и заказов из Postgres
// в виде JSON-эндпоинта `/analytics.json` + HTML-странички `/analytics`
// для людей (mini Grafana без Grafana).
//
// Все запросы дешёвые: считают по таблицам `conversations` и `orders`,
// используют только существующие индексы (created_at DESC, status, prompt_variant).

import { query } from './db.js';
import { child } from './log.js';

const log = child('analytics');

export interface AnalyticsTotals {
  conversations_total: number;
  conversations_24h: number;
  conversations_7d: number;
  unique_users_total: number;
  unique_users_24h: number;
  orders_total: number;
  orders_24h: number;
  orders_paid_total: number;
  fallback_total: number;
  fallback_rate: number;
}

export interface TopQuery {
  user_text: string;
  count: number;
}

export interface VariantStats {
  variant: string;
  count: number;
  avg_user_text_length: number;
  avg_bot_text_length: number;
}

export interface DailyBucket {
  day: string;
  conversations: number;
  unique_users: number;
}

export interface TopCategory {
  category: string;
  matches: number;
}

export interface AnalyticsSnapshot {
  generated_at: string;
  totals: AnalyticsTotals;
  daily: DailyBucket[];
  top_queries_7d: TopQuery[];
  prompt_variants: VariantStats[];
  top_categories_7d: TopCategory[];
  top_skus_7d: TopQuery[];
}

const EMPTY_TOTALS: AnalyticsTotals = {
  conversations_total: 0,
  conversations_24h: 0,
  conversations_7d: 0,
  unique_users_total: 0,
  unique_users_24h: 0,
  orders_total: 0,
  orders_24h: 0,
  orders_paid_total: 0,
  fallback_total: 0,
  fallback_rate: 0,
};

async function fetchTotals(): Promise<AnalyticsTotals> {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM conversations)                                                          AS conversations_total,
      (SELECT COUNT(*)::int FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours')           AS conversations_24h,
      (SELECT COUNT(*)::int FROM conversations WHERE created_at > NOW() - INTERVAL '7 days')             AS conversations_7d,
      (SELECT COUNT(DISTINCT user_id)::int FROM conversations)                                            AS unique_users_total,
      (SELECT COUNT(DISTINCT user_id)::int FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours') AS unique_users_24h,
      (SELECT COUNT(*)::int FROM orders)                                                                  AS orders_total,
      (SELECT COUNT(*)::int FROM orders WHERE created_at > NOW() - INTERVAL '24 hours')                   AS orders_24h,
      (SELECT COUNT(*)::int FROM orders WHERE paid_at IS NOT NULL)                                        AS orders_paid_total,
      (SELECT COUNT(*)::int FROM conversations WHERE matched_skus IS NULL)                                AS fallback_total
  `);
  const row = rows[0] as Record<string, number>;
  const total = row.conversations_total || 0;
  const fallback = row.fallback_total || 0;
  return {
    conversations_total: total,
    conversations_24h: row.conversations_24h || 0,
    conversations_7d: row.conversations_7d || 0,
    unique_users_total: row.unique_users_total || 0,
    unique_users_24h: row.unique_users_24h || 0,
    orders_total: row.orders_total || 0,
    orders_24h: row.orders_24h || 0,
    orders_paid_total: row.orders_paid_total || 0,
    fallback_total: fallback,
    fallback_rate: total > 0 ? Math.round((fallback / total) * 10_000) / 10_000 : 0,
  };
}

async function fetchDaily(days = 7): Promise<DailyBucket[]> {
  const { rows } = await query(
    `
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      COUNT(*)::int                                          AS conversations,
      COUNT(DISTINCT user_id)::int                           AS unique_users
    FROM conversations
    WHERE created_at > NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY 1 DESC
    `,
    [String(days)]
  );
  return rows as DailyBucket[];
}

async function fetchTopQueries(limit = 10): Promise<TopQuery[]> {
  const { rows } = await query(
    `
    SELECT
      lower(user_text) AS user_text,
      COUNT(*)::int     AS count
    FROM conversations
    WHERE created_at > NOW() - INTERVAL '7 days'
      AND char_length(user_text) BETWEEN 3 AND 200
    GROUP BY 1
    ORDER BY count DESC, user_text ASC
    LIMIT $1
    `,
    [limit]
  );
  return rows as TopQuery[];
}

async function fetchVariantStats(): Promise<VariantStats[]> {
  const { rows } = await query(`
    SELECT
      COALESCE(prompt_variant, 'baseline')   AS variant,
      COUNT(*)::int                          AS count,
      AVG(char_length(user_text))::numeric(10,1) AS avg_user_text_length,
      AVG(char_length(bot_text))::numeric(10,1)  AS avg_bot_text_length
    FROM conversations
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY count DESC
  `);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    variant: String(r.variant),
    count: Number(r.count),
    avg_user_text_length: Number(r.avg_user_text_length),
    avg_bot_text_length: Number(r.avg_bot_text_length),
  }));
}

async function fetchTopCategories(limit = 5): Promise<TopCategory[]> {
  const { rows } = await query(
    `
    SELECT
      p.category    AS category,
      COUNT(*)::int AS matches
    FROM conversations c
    CROSS JOIN LATERAL unnest(c.matched_skus) AS sku
    JOIN products p ON p.sku = sku
    WHERE c.created_at > NOW() - INTERVAL '7 days'
    GROUP BY p.category
    ORDER BY matches DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows as TopCategory[];
}

async function fetchTopSkus(limit = 10): Promise<TopQuery[]> {
  // Используем форму `{ user_text, count }` чтобы вёрстка в analytics-страничке
  // могла переиспользовать рендер «топ-запросов» для «топ-SKU».
  const { rows } = await query(
    `
    SELECT
      sku           AS user_text,
      COUNT(*)::int AS count
    FROM conversations c
    CROSS JOIN LATERAL unnest(c.matched_skus) AS sku
    WHERE c.created_at > NOW() - INTERVAL '7 days'
    GROUP BY sku
    ORDER BY count DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows as TopQuery[];
}

export async function buildAnalyticsSnapshot(): Promise<AnalyticsSnapshot> {
  const [totals, daily, topQueries, variants, categories, skus] = await Promise.all([
    fetchTotals().catch((err) => {
      log.warn({ err: (err as Error).message }, 'totals: запрос упал');
      return EMPTY_TOTALS;
    }),
    fetchDaily().catch(() => []),
    fetchTopQueries().catch(() => []),
    fetchVariantStats().catch(() => []),
    fetchTopCategories().catch(() => []),
    fetchTopSkus().catch(() => []),
  ]);

  return {
    generated_at: new Date().toISOString(),
    totals,
    daily,
    top_queries_7d: topQueries,
    prompt_variants: variants,
    top_categories_7d: categories,
    top_skus_7d: skus,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderTotalsCard(label: string, value: number | string, sub?: string): string {
  return `<div class="card">
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="card-value">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="card-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function renderTopQueries(items: TopQuery[], emptyLabel: string): string {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyLabel)}</p>`;
  const max = Math.max(...items.map((i) => i.count));
  return `<ul class="bars">
    ${items
      .map((i) => {
        const pct = max > 0 ? Math.max(2, Math.round((i.count / max) * 100)) : 0;
        return `<li>
          <span class="label">${escapeHtml(i.user_text)}</span>
          <span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span>
          <span class="value">${i.count}</span>
        </li>`;
      })
      .join('')}
  </ul>`;
}

function renderVariants(variants: VariantStats[]): string {
  if (!variants.length) return '<p class="muted">за 7 дней нет данных по variant' + "'" + 'ам</p>';
  return `<table class="variants">
    <thead>
      <tr>
        <th>variant</th>
        <th class="num">диалогов</th>
        <th class="num">avg user-text</th>
        <th class="num">avg bot-text</th>
      </tr>
    </thead>
    <tbody>
      ${variants
        .map(
          (v) => `<tr>
        <td><code>${escapeHtml(v.variant)}</code></td>
        <td class="num">${v.count}</td>
        <td class="num">${v.avg_user_text_length.toFixed(1)}</td>
        <td class="num">${v.avg_bot_text_length.toFixed(1)}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function renderDaily(daily: DailyBucket[]): string {
  if (!daily.length) return '<p class="muted">за 7 дней нет данных</p>';
  return `<table class="daily">
    <thead><tr><th>день</th><th class="num">диалогов</th><th class="num">уников</th></tr></thead>
    <tbody>
      ${daily
        .map(
          (d) =>
            `<tr><td>${escapeHtml(d.day)}</td><td class="num">${d.conversations}</td><td class="num">${d.unique_users}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

/** Полный HTML дашборда. Без JS-фреймворков и без сети — чистый CSS+HTML. */
export function renderAnalyticsHtml(snap: AnalyticsSnapshot): string {
  const t = snap.totals;
  const fallbackPct = formatPct(t.fallback_rate);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Analytics — AI consultant for the store</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #fafafa; color: #1a1a1a; margin: 0; padding: 24px; }
    @media (prefers-color-scheme: dark) { body { background: #121212; color: #ececec; } }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .generated { color: #888; font-size: 13px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 32px; }
    .card { background: white; border-radius: 8px; padding: 14px; border: 1px solid #e5e7eb; }
    @media (prefers-color-scheme: dark) { .card { background: #1c1c1c; border-color: #2a2a2a; } }
    .card-label { color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
    .card-value { font-size: 28px; font-weight: 600; margin-top: 4px; }
    .card-sub { color: #9ca3af; font-size: 12px; margin-top: 2px; }
    section { margin-bottom: 32px; }
    section h2 { font-size: 16px; margin: 0 0 12px; color: #374151; }
    @media (prefers-color-scheme: dark) { section h2 { color: #d1d5db; } }
    .muted { color: #9ca3af; font-style: italic; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; }
    @media (prefers-color-scheme: dark) { table { background: #1c1c1c; border-color: #2a2a2a; } }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f3f4f6; font-size: 13px; }
    @media (prefers-color-scheme: dark) { th, td { border-color: #2a2a2a; } }
    th { background: #f9fafb; font-weight: 600; }
    @media (prefers-color-scheme: dark) { th { background: #161616; } }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    ul.bars { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    ul.bars li { display: grid; grid-template-columns: 1fr 100px 50px; gap: 8px; align-items: center; font-size: 13px; }
    ul.bars .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ul.bars .bar { background: #f3f4f6; border-radius: 4px; height: 8px; overflow: hidden; }
    @media (prefers-color-scheme: dark) { ul.bars .bar { background: #2a2a2a; } }
    ul.bars .bar-fill { display: block; height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6); }
    ul.bars .value { text-align: right; font-variant-numeric: tabular-nums; color: #6b7280; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
    @media (prefers-color-scheme: dark) { code { background: #2a2a2a; } }
    a.json { font-size: 12px; color: #6366f1; text-decoration: none; }
    a.json:hover { text-decoration: underline; }
    .nav { margin-bottom: 16px; font-size: 13px; }
    .nav a { color: #6366f1; text-decoration: none; margin-right: 12px; }
  </style>
</head>
<body>
  <div class="nav">
    <a href="/">← home</a>
    <a href="/docs">/docs (Swagger UI)</a>
    <a href="/metrics">/metrics (Prometheus)</a>
    <a href="/analytics.json" class="json">JSON snapshot →</a>
  </div>
  <h1>Analytics — AI consultant for the store</h1>
  <div class="generated">сгенерировано: ${escapeHtml(snap.generated_at)}</div>

  <div class="grid">
    ${renderTotalsCard('Диалоги всего', t.conversations_total)}
    ${renderTotalsCard('Диалоги 24ч', t.conversations_24h, `${t.unique_users_24h} уников`)}
    ${renderTotalsCard('Диалоги 7д', t.conversations_7d)}
    ${renderTotalsCard('Уников всего', t.unique_users_total)}
    ${renderTotalsCard('Заказы всего', t.orders_total, `${t.orders_paid_total} оплачено`)}
    ${renderTotalsCard('Заказы 24ч', t.orders_24h)}
    ${renderTotalsCard('Fallback rate', fallbackPct, `${t.fallback_total} без матча`)}
  </div>

  <section>
    <h2>Активность по дням (7д)</h2>
    ${renderDaily(snap.daily)}
  </section>

  <section>
    <h2>Топ запросов (7д)</h2>
    ${renderTopQueries(snap.top_queries_7d, 'нет данных за период')}
  </section>

  <section>
    <h2>Топ категорий по матчам (7д)</h2>
    ${
      snap.top_categories_7d.length
        ? `<table>
            <thead><tr><th>категория</th><th class="num">матчей</th></tr></thead>
            <tbody>
              ${snap.top_categories_7d
                .map(
                  (c) =>
                    `<tr><td>${escapeHtml(c.category)}</td><td class="num">${c.matches}</td></tr>`
                )
                .join('')}
            </tbody>
          </table>`
        : '<p class="muted">за 7 дней нет матчей по каталогу</p>'
    }
  </section>

  <section>
    <h2>Топ SKU по матчам (7д)</h2>
    ${renderTopQueries(snap.top_skus_7d, 'за 7 дней нет матчей')}
  </section>

  <section>
    <h2>A/B-фреймворк: per-variant стата (7д)</h2>
    ${renderVariants(snap.prompt_variants)}
  </section>
</body>
</html>`;
}
