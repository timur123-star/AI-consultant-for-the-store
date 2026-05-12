// RAG — Retrieval Augmented Generation.
// 1. Превращаем запрос пользователя в вектор (embedQuery).
// 2. Ищем top-K товаров по косинусному расстоянию в pgvector.
// 3. Передаём найденные товары LLM как контекст.
//
// Это даёт боту способность понимать естественный язык
// ("что-то тёплое для зимы до 3к") без перечисления команд.
import { query, toPgVector } from './db.js';
import { embedQuery } from './embeddings.js';
import type { Product, ProductWithDistance } from './types.js';

const DEFAULT_LIMIT = 3;
// Оператор <=> в pgvector — это cosine distance (1 - cosine_similarity).
// Чем меньше distance, тем ближе товар к запросу.
const RELEVANCE_THRESHOLD = 0.55;

export interface FindProductsOptions {
  limit?: number;
}

export async function findProducts(
  userQuery: string,
  { limit = DEFAULT_LIMIT }: FindProductsOptions = {}
): Promise<ProductWithDistance[]> {
  const vector = await embedQuery(userQuery);
  const vectorLiteral = toPgVector(vector);

  const { rows } = await query<ProductWithDistance>(
    `SELECT id, sku, name, description, price, category, in_stock, image_url, tags,
            (embedding <=> $1::vector) AS distance
       FROM products
      WHERE in_stock = TRUE
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vectorLiteral, limit]
  );

  // Фильтруем заведомо нерелевантные результаты — лучше показать fallback,
  // чем выдавать любые товары, лишь бы что-то показать.
  return rows.filter((row) => Number(row.distance) < RELEVANCE_THRESHOLD);
}

export function formatProductsForPrompt(
  products: Array<Pick<Product, 'name' | 'price' | 'category' | 'sku' | 'description'>>
): string {
  if (!products.length) return 'Подходящих товаров в каталоге не найдено.';
  return products
    .map(
      (p, i) =>
        `${i + 1}. ${p.name} — ${p.price}₽ (категория: ${p.category}, sku: ${p.sku})\n   ${p.description}`
    )
    .join('\n');
}

// Берём топ-N товаров по частоте заказов за последние 30 дней.
// Используется для /featured и fallback'а, когда поиск ничего не нашёл.
export async function getFeaturedProducts(limit = 6): Promise<Product[]> {
  const { rows } = await query<Product>(
    `WITH popular AS (
       SELECT product_id, COUNT(*) AS cnt
         FROM orders
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY product_id
     )
     SELECT p.id, p.sku, p.name, p.description, p.price, p.category, p.in_stock,
            p.image_url, p.tags,
            COALESCE(pop.cnt, 0) AS popularity
       FROM products p
  LEFT JOIN popular pop ON pop.product_id = p.id
      WHERE p.in_stock = TRUE
   ORDER BY popularity DESC, p.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getProductById(id: number): Promise<Product | null> {
  const { rows } = await query<Product>(
    `SELECT id, sku, name, description, price, category, in_stock, image_url, tags
       FROM products WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getProductBySku(sku: string): Promise<Product | null> {
  const { rows } = await query<Product>(
    `SELECT id, sku, name, description, price, category, in_stock, image_url, tags
       FROM products WHERE sku = $1`,
    [sku]
  );
  return rows[0] ?? null;
}

export interface TextSearchOptions {
  limit?: number;
}

// Текстовый поиск по SKU / имени / категории — быстрый lookup для менеджера.
// Использует ILIKE, подходит для каталога до нескольких тысяч позиций.
export async function textSearchProducts(
  text: string,
  { limit = 10 }: TextSearchOptions = {}
): Promise<Product[]> {
  const pattern = `%${text.trim()}%`;
  const { rows } = await query<Product>(
    `SELECT id, sku, name, description, price, category, in_stock, image_url, tags
       FROM products
      WHERE sku ILIKE $1
         OR name ILIKE $1
         OR category ILIKE $1
      ORDER BY (sku ILIKE $1) DESC, name
      LIMIT $2`,
    [pattern, limit]
  );
  return rows;
}
