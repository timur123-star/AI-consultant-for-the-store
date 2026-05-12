import pg, { type QueryResult, type QueryResultRow } from 'pg';
import { config } from './config.js';
import { child } from './log.js';

const log = child('db');
const { Pool } = pg;

// На Railway внутренние URL всегда содержат "railway.internal" и используют sslmode=require
// для proxy. Локально (docker compose / dev) SSL не нужен.
function shouldUseSsl(url: string): boolean {
  return /railway/.test(url) || /sslmode=require/.test(url);
}

// Полезное предупреждение: если бот запустился внутри Railway, но DATABASE_URL ведёт
// на localhost — почти наверняка не настроен Reference на Postgres-сервис.
if (process.env.RAILWAY_ENVIRONMENT && /(localhost|127\.0\.0\.1|::1)/.test(config.databaseUrl)) {
  log.error('DATABASE_URL указывает на localhost в Railway. Пробрось Reference на Postgres.');
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: shouldUseSsl(config.databaseUrl) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  log.error({ err }, 'неожиданная ошибка пула');
});

// pgvector ожидает строку вида '[0.1,0.2,...]'
export function toPgVector(arr: ArrayLike<number>): string {
  return `[${Array.from(arr).join(',')}]`;
}

// Генерик-параметр даёт вызывающим сайтам возможность указать форму строки (например Product),
// без бойлерплейта кастов. По умолчанию — open-shape строка, что равносильно поведению pg `.query()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: ReadonlyArray<unknown>
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
