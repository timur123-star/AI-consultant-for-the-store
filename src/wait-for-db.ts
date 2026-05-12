// Ждём готовности Postgres до запуска миграций / индексации / бота.
// На Railway сервис бота может стартовать раньше чем Postgres примет соединения,
// особенно при первом деплое или после рестарта БД.
import pg from 'pg';
import { config } from './config.js';
import { child } from './log.js';

const log = child('wait-for-db');
const MAX_ATTEMPTS = 60; // ~300 секунд при backoff 5с
const BACKOFF_MS = 5000;

function isLocalhost(url: string): boolean {
  return /(@|\/\/)(localhost|127\.0\.0\.1|::1)(:|\/)/.test(url);
}

// Маскируем пароль, чтобы в логах было видно host:port, но не credentials.
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(невалидный URL)';
  }
}

export async function waitForDb(): Promise<void> {
  log.info({ url: safeUrl(config.databaseUrl) }, 'подключаюсь к Postgres');

  if (isLocalhost(config.databaseUrl) && process.env.RAILWAY_ENVIRONMENT) {
    log.error(
      'DATABASE_URL указывает на localhost в Railway. Пробрось Reference на Postgres-сервис.'
    );
  }

  const { Client } = pg;
  let lastErr: { code?: string; message?: string } | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = new Client({
      connectionString: config.databaseUrl,
      ssl:
        config.databaseUrl.includes('railway') || config.databaseUrl.includes('sslmode=require')
          ? { rejectUnauthorized: false }
          : false,
      // короткий connect timeout, чтобы быстро провалить попытку и попробовать ещё раз
      connectionTimeoutMillis: 5_000,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      if (attempt > 1) {
        log.info({ attempt }, 'подключился к Postgres');
      }
      return;
    } catch (err) {
      lastErr = err;
      log.warn({ attempt, max: MAX_ATTEMPTS, code: err.code, backoffMs: BACKOFF_MS }, err.message);
      try {
        await client.end();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
  throw new Error(
    `Postgres не стал доступен за ${(MAX_ATTEMPTS * BACKOFF_MS) / 1000} секунд: ${lastErr?.message}`
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  waitForDb()
    .then(() => process.exit(0))
    .catch((err) => {
      log.fatal({ err }, 'не смог дождаться Postgres');
      process.exit(1);
    });
}
