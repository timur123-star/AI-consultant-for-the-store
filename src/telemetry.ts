// Опциональная телеметрия: Sentry (error tracking) и OpenTelemetry (distributed tracing).
//
// Включается строго через env-переменные:
//   - SENTRY_DSN          → инициализируется Sentry (под капотом он же поднимает OTel).
//   - OTEL_EXPORTER_OTLP_ENDPOINT → инициализируется самостоятельный OpenTelemetry NodeSDK
//                                   с OTLP/HTTP экспортёром (используется только если Sentry
//                                   не включён, чтобы не было двух OTel-инстансов).
//
// Без этих переменных модуль становится no-op: ничего не загружается, нет сетевых
// вызовов, нулевой оверхед в проде. Это даёт «продакшен-готовность» без зависимости
// от внешних сервисов и API-ключей.
//
// Используется в bootstrap.ts (initTelemetry → shutdownTelemetry в SIGTERM) и
// в bot.ts через captureException() для отправки пойманных в catch ошибок.

import { child } from './log.js';

const log = child('telemetry');

// Лениво загружаемые модули — типы импортируем через type-only, чтобы не тянуть
// рантайм-код при отключённой телеметрии.
type SentryModule = typeof import('@sentry/node');
type NodeSDK = import('@opentelemetry/sdk-node').NodeSDK;

interface TelemetryState {
  sentry: SentryModule | null;
  otelSdk: NodeSDK | null;
}

const state: TelemetryState = {
  sentry: null,
  otelSdk: null,
};

export interface TelemetryStatus {
  sentry: boolean;
  otel: boolean;
}

export function telemetryStatus(): TelemetryStatus {
  return {
    sentry: state.sentry !== null,
    otel: state.otelSdk !== null,
  };
}

async function initSentry(dsn: string): Promise<void> {
  try {
    const Sentry: SentryModule = await import('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      // Tracing — отключён по умолчанию (0). Можно поднять до 0.1 в проде.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
      // Не отправляем PII (user_id, IP) пока не запросим явно.
      sendDefaultPii: false,
    });
    state.sentry = Sentry;
    log.info(
      {
        environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE || '0',
      },
      'Sentry инициализирован'
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Sentry init не удался — error-tracking отключён'
    );
  }
}

async function initOtel(endpoint: string): Promise<void> {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { getNodeAutoInstrumentations } =
      await import('@opentelemetry/auto-instrumentations-node');
    const serviceName = process.env.OTEL_SERVICE_NAME || 'ai-consultant-for-the-store';
    // OTLP HTTP принимает на /v1/traces; endpoint можно задавать с или без слэша.
    const tracesUrl = `${endpoint.replace(/\/+$/, '')}/v1/traces`;
    const sdk: NodeSDK = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter({ url: tracesUrl }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    state.otelSdk = sdk;
    log.info({ serviceName, tracesUrl }, 'OpenTelemetry инициализирован');
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OpenTelemetry init не удался — трейсинг отключён'
    );
  }
}

// Главная точка входа. Вызвать в bootstrap.ts ДО любых других подключений
// (Postgres pool, redis client) если хотим auto-instrumentation.
export async function initTelemetry(): Promise<TelemetryStatus> {
  const sentryDsn = (process.env.SENTRY_DSN || '').trim();
  const otelEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();

  if (sentryDsn) {
    await initSentry(sentryDsn);
  }

  // Sentry SDK сам поднимает OTel — поэтому стенд-элоун NodeSDK включаем только
  // если Sentry не инициализирован. Иначе будет два OTel-инстанса и непредсказуемое
  // поведение auto-instrumentation.
  if (otelEndpoint && !state.sentry) {
    await initOtel(otelEndpoint);
  } else if (otelEndpoint && state.sentry) {
    log.info(
      'OTEL_EXPORTER_OTLP_ENDPOINT задан, но Sentry уже активен (он сам поднимает OTel). Стенд-элоун NodeSDK пропущен.'
    );
  }

  if (!state.sentry && !state.otelSdk) {
    log.info('телеметрия выключена (нет SENTRY_DSN и OTEL_EXPORTER_OTLP_ENDPOINT)');
  }

  return telemetryStatus();
}

// Безопасный capture: если Sentry не инициализирован — no-op.
// Никогда не бросает, чтобы не превратить логирование ошибки в новую ошибку.
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!state.sentry) return;
  try {
    state.sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // намеренно глотаем — телеметрия не должна валить приложение
  }
}

// Graceful shutdown — даёт время дослать оставшиеся события до бэкенда.
export async function shutdownTelemetry(timeoutMs = 2000): Promise<void> {
  if (state.otelSdk) {
    try {
      await state.otelSdk.shutdown();
    } catch {
      // ignore
    }
    state.otelSdk = null;
  }
  if (state.sentry) {
    try {
      await state.sentry.close(timeoutMs);
    } catch {
      // ignore
    }
    state.sentry = null;
  }
}

// Для тестов: сбросить state, не вызывая shutdown.
export function _resetTelemetryStateForTests(): void {
  state.sentry = null;
  state.otelSdk = null;
}
