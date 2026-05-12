// Логирование всех диалогов в Postgres — владелец магазина потом сможет:
//   - увидеть какие товары спрашивают чаще всего,
//   - найти запросы которым бот не нашёл ответ (matched_skus IS NULL),
//   - использовать данные для расширения каталога.
import { query } from './db.js';
import { child } from './log.js';
import { VALID_STATUS_SET } from './order-status.js';
import type { Order, OrderWithProduct } from './types.js';

const log = child('logger');

export interface LogConversationArgs {
  userId: number;
  username?: string | null;
  userText: string;
  botText: string;
  matchedSkus?: string[];
  promptVariant?: string | null;
}

export async function logConversation({
  userId,
  username,
  userText,
  botText,
  matchedSkus,
  promptVariant,
}: LogConversationArgs): Promise<void> {
  try {
    await query(
      `INSERT INTO conversations (user_id, username, user_text, bot_text, matched_skus, prompt_variant)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        username || null,
        userText,
        botText,
        matchedSkus?.length ? matchedSkus : null,
        promptVariant || null,
      ]
    );
  } catch (err) {
    // Логирование не должно валить ответ пользователю.
    log.error({ err }, 'не удалось записать диалог');
  }
}

export interface RecordOrderArgs {
  userId: number;
  username?: string | null;
  productId: number;
  status?: string;
}

export async function recordOrder({
  userId,
  username,
  productId,
  status = 'new',
}: RecordOrderArgs): Promise<Order> {
  const { rows } = await query(
    `INSERT INTO orders (user_id, username, product_id, status)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at, status, user_id, product_id`,
    [userId, username || null, productId, status]
  );
  return rows[0] as Order;
}

// Обновляет статус заказа. Допустимые статусы контролирует бизнес-логика выше.
export async function updateOrderStatus(orderId: number, status: string): Promise<Order | null> {
  if (!VALID_STATUS_SET.has(status)) {
    log.warn({ orderId, status }, 'попытка выставить невалидный статус');
    return null;
  }
  const { rows } = await query(
    `UPDATE orders
        SET status = $2, updated_at = NOW()
      WHERE id = $1
  RETURNING id, user_id, product_id, status, created_at, updated_at`,
    [orderId, status]
  );
  return (rows[0] as Order) || null;
}

export interface ConversationStats {
  total: number;
  last_24h: number;
  unique_users: number;
}

export interface OrderStats {
  total: number;
  last_24h: number;
}

export interface TopProductStat {
  name: string;
  cnt: number;
}

export interface StatsResult {
  conversations: ConversationStats;
  orders: OrderStats;
  topProducts: TopProductStat[];
}

// Последние N заказов для /orders менеджера.
export async function getRecentOrders(limit = 10): Promise<OrderWithProduct[]> {
  const { rows } = await query(
    `SELECT o.id, o.user_id, o.username, o.status, o.created_at, o.updated_at,
            p.name AS product_name, p.sku, p.price
       FROM orders o
       JOIN products p ON p.id = o.product_id
   ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows as OrderWithProduct[];
}

export async function getStats(): Promise<StatsResult> {
  const [{ rows: convRows }, { rows: orderRows }, { rows: topRows }] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
         COUNT(DISTINCT user_id)::int AS unique_users
       FROM conversations`
    ),
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h
       FROM orders`
    ),
    query(
      `SELECT p.name, COUNT(*)::int AS cnt
         FROM orders o
         JOIN products p ON p.id = o.product_id
        WHERE o.created_at > NOW() - INTERVAL '7 days'
        GROUP BY p.name
        ORDER BY cnt DESC
        LIMIT 5`
    ),
  ]);
  return {
    conversations: convRows[0] as ConversationStats,
    orders: orderRows[0] as OrderStats,
    topProducts: topRows as TopProductStat[],
  };
}
