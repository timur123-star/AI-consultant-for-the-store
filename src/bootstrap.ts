// Единая точка входа для деплоя на Railway: миграции → индексация → запуск бота.
// Всё в одном Node-процессе, чтобы шелл-цепочка `&&` не разрывалась между контейнерами.
// Поднимаем HTTP-сервер с пятью endpoint'ами:
//   - /                — friendly home для health-check Railway
//   - /health          — liveness-проба, всегда 200 пока процесс жив
//   - /ready           — readiness-проба, 200 только когда Postgres и Redis отвечают
//   - /metrics         — Prometheus text exposition format (для скрейпа)
//   - /metrics.json    — JSON snapshot in-process метрик (для людей)
//   - $WEBHOOK_PATH    — telegram webhook (только если BOT_MODE=webhook)
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pool, closeDb } from './db.js';
import { waitForDb } from './wait-for-db.js';
import { indexCatalog } from '../scripts/index-catalog.js';
import { child } from './log.js';
import { snapshot as metricsSnapshot } from './metrics.js';
import { pingRedis } from './redis.js';
import { toPrometheus, PROM_CONTENT_TYPE } from './prom.js';
import { config } from './config.js';
import { resolveRepoFile } from './paths.js';
import { initTelemetry, shutdownTelemetry, telemetryStatus } from './telemetry.js';
import { handleDocsRequest, verifyDocsAvailable } from './docs.js';
import { buildAnalyticsSnapshot, renderAnalyticsHtml } from './analytics.js';

// Отключаем автозапуск bot.js при импорте — мы сами решим режим (polling/webhook).
process.env.BOT_NO_AUTOSTART = '1';

const log = child('bootstrap');

async function applySchema() {
  const schemaPath = resolveRepoFile(import.meta.url, 'db/schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  log.info({ schemaPath }, 'миграция: применяю схему');
  await pool.query(sql);
  log.info('миграция: готово');
}

async function checkReady() {
  // Параллельно пингуем оба бэкенда. Любая ошибка → not ready.
  const checks = await Promise.allSettled([pool.query('SELECT 1'), pingRedis()]);
  return {
    postgres: checks[0].status === 'fulfilled',
    redis: checks[1].status === 'fulfilled' && checks[1].value === true,
  };
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function textResponse(
  res: ServerResponse,
  status: number,
  body: string,
  contentType?: string
): void {
  res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8' });
  res.end(body);
}

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface StartHealthServerOptions {
  webhookHandler?: WebhookHandler;
  webhookPath?: string;
}

function startHealthServer({
  webhookHandler,
  webhookPath,
}: StartHealthServerOptions = {}): http.Server {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];

    // Telegram webhook — обрабатываем ДО всех остальных путей.
    if (webhookHandler && url === webhookPath) {
      try {
        return webhookHandler(req, res);
      } catch (err) {
        log.error({ err: err.message || err }, 'webhook handler threw');
        return jsonResponse(res, 500, { ok: false });
      }
    }

    // /docs, /docs/openapi.yaml, /docs/swagger-*.css|.js — Swagger UI.
    if (url === '/docs' || url.startsWith('/docs/') || url === '/openapi.yaml') {
      try {
        if (await handleDocsRequest(req, res)) return;
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'ошибка в docs-хандлере');
      }
    }

    if (url === '/health') {
      return jsonResponse(res, 200, {
        status: 'ok',
        uptime_seconds: Math.floor(process.uptime()),
        telemetry: telemetryStatus(),
      });
    }
    if (url === '/ready') {
      try {
        const state = await checkReady();
        const ok = state.postgres && state.redis;
        return jsonResponse(res, ok ? 200 : 503, { ready: ok, ...state });
      } catch (err) {
        return jsonResponse(res, 503, { ready: false, error: err.message || String(err) });
      }
    }
    // Prometheus формат — стандартный путь /metrics. Скрейперы ждут именно его.
    if (url === '/metrics') {
      return textResponse(res, 200, toPrometheus(metricsSnapshot()), PROM_CONTENT_TYPE);
    }
    // JSON snapshot для людей и для дашбордов, которые ждут JSON.
    if (url === '/metrics.json') {
      return jsonResponse(res, 200, metricsSnapshot());
    }
    // /analytics — хэндмейд дашборд по таблице conversations.
    if (url === '/analytics' || url === '/analytics.json') {
      try {
        const snap = await buildAnalyticsSnapshot();
        if (url === '/analytics.json') {
          return jsonResponse(res, 200, snap);
        }
        return textResponse(res, 200, renderAnalyticsHtml(snap), 'text/html; charset=utf-8');
      } catch (err) {
        log.warn(
          { err: (err as Error).message || String(err) },
          'analytics: ошибка сборки snapshot'
        );
        return jsonResponse(res, 500, { error: 'analytics unavailable' });
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('AI-консультант жив. Пиши боту в Telegram.');
  });
  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'health-сервер слушает 0.0.0.0');
  });
  return server;
}

async function main() {
  // Телеметрия — первой, чтобы auto-instrumentation успела подхватить http/pg/redis.
  // Без SENTRY_DSN и OTEL_EXPORTER_OTLP_ENDPOINT — no-op.
  const telemetry = await initTelemetry();
  const docs = await verifyDocsAvailable();
  log.info({ telemetry, docs }, 'старт последовательности: wait-db → migrate → index → bot');
  log.info({ mode: config.botMode }, 'режим бота');
  await waitForDb();
  await applySchema();
  log.info('индексация: загружаю модель embeddings и считаю векторы…');
  const n = await indexCatalog(undefined);
  log.info({ count: n }, 'индексация: товаров в pgvector');

  log.info('запускаю telegram-бота…');
  if (config.botMode === 'webhook') {
    if (!config.webhookDomain) {
      throw new Error('BOT_MODE=webhook требует WEBHOOK_DOMAIN (например https://your.host)');
    }
    const { startWebhook } = await import('./bot.js');
    const handler = await startWebhook({
      domain: config.webhookDomain,
      path: config.webhookPath,
      secretToken: config.webhookSecretToken,
    });
    startHealthServer({ webhookHandler: handler, webhookPath: config.webhookPath });
    log.info({ path: config.webhookPath }, 'webhook режим активен');
  } else {
    startHealthServer();
    const { startPolling } = await import('./bot.js');
    await startPolling();
  }
}

main().catch((err) => {
  log.fatal({ err }, 'фатальная ошибка при старте');
  shutdownTelemetry().catch(() => {});
  closeDb().catch(() => {});
  process.exit(1);
});
