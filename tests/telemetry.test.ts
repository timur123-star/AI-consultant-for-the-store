import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SENTRY_DSN_ORIGINAL = process.env.SENTRY_DSN;
const OTEL_ORIGINAL = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const NODE_ENV_ORIGINAL = process.env.NODE_ENV;

const sentryInitMock = vi.fn();
const sentryCaptureMock = vi.fn();
const sentryCloseMock = vi.fn().mockResolvedValue(true);

const otelStartMock = vi.fn();
const otelShutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@sentry/node', () => ({
  init: sentryInitMock,
  captureException: sentryCaptureMock,
  close: sentryCloseMock,
}));

vi.mock('@opentelemetry/sdk-node', () => {
  class NodeSDK {
    start = otelStartMock;
    shutdown = otelShutdownMock;
  }
  return { NodeSDK };
});

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(opts: Record<string, unknown>) {
      Object.assign(this, opts);
    }
  },
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [],
}));

const {
  initTelemetry,
  captureException,
  shutdownTelemetry,
  telemetryStatus,
  _resetTelemetryStateForTests,
} = await import('../src/telemetry.js');

function clearTelemetryEnv() {
  delete process.env.SENTRY_DSN;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.SENTRY_ENVIRONMENT;
  delete process.env.SENTRY_RELEASE;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
  delete process.env.OTEL_SERVICE_NAME;
}

beforeEach(() => {
  clearTelemetryEnv();
  sentryInitMock.mockReset();
  sentryCaptureMock.mockReset();
  sentryCloseMock.mockClear().mockResolvedValue(true);
  otelStartMock.mockReset();
  otelShutdownMock.mockClear().mockResolvedValue(undefined);
  _resetTelemetryStateForTests();
});

afterEach(() => {
  // восстанавливаем оригинальные env, чтобы не повлиять на другие тесты
  if (SENTRY_DSN_ORIGINAL !== undefined) process.env.SENTRY_DSN = SENTRY_DSN_ORIGINAL;
  if (OTEL_ORIGINAL !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = OTEL_ORIGINAL;
  if (NODE_ENV_ORIGINAL !== undefined) process.env.NODE_ENV = NODE_ENV_ORIGINAL;
});

describe('initTelemetry', () => {
  it('no-op без env: оба флага false, ничего не зовётся', async () => {
    const status = await initTelemetry();
    expect(status).toEqual({ sentry: false, otel: false });
    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(otelStartMock).not.toHaveBeenCalled();
  });

  it('пустой SENTRY_DSN не активирует Sentry', async () => {
    process.env.SENTRY_DSN = '   ';
    const status = await initTelemetry();
    expect(status.sentry).toBe(false);
    expect(sentryInitMock).not.toHaveBeenCalled();
  });

  it('активирует Sentry при заданном DSN', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    process.env.SENTRY_ENVIRONMENT = 'production';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
    const status = await initTelemetry();
    expect(status.sentry).toBe(true);
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    const initArg = sentryInitMock.mock.calls[0][0];
    expect(initArg.dsn).toBe('https://abc@sentry.io/1');
    expect(initArg.environment).toBe('production');
    expect(initArg.tracesSampleRate).toBe(0.25);
    expect(initArg.sendDefaultPii).toBe(false);
  });

  it('активирует OTel при заданном endpoint и отсутствии Sentry', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318/';
    const status = await initTelemetry();
    expect(status.otel).toBe(true);
    expect(otelStartMock).toHaveBeenCalledTimes(1);
  });

  it('пропускает OTel если активен Sentry (Sentry сам поднимает OTel)', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    const status = await initTelemetry();
    expect(status.sentry).toBe(true);
    expect(status.otel).toBe(false);
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(otelStartMock).not.toHaveBeenCalled();
  });

  it('переживает падение Sentry init без падения процесса', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    sentryInitMock.mockImplementation(() => {
      throw new Error('boom');
    });
    const status = await initTelemetry();
    expect(status.sentry).toBe(false);
  });
});

describe('captureException', () => {
  it('no-op без инициализации — не падает', () => {
    expect(() => captureException(new Error('x'))).not.toThrow();
    expect(sentryCaptureMock).not.toHaveBeenCalled();
  });

  it('передаёт ошибку и контекст в Sentry после init', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    await initTelemetry();
    const err = new Error('oops');
    captureException(err, { userId: 42, scope: 'test' });
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const [capturedErr, opts] = sentryCaptureMock.mock.calls[0];
    expect(capturedErr).toBe(err);
    expect(opts).toEqual({ extra: { userId: 42, scope: 'test' } });
  });

  it('глотает ошибки телеметрии — не ломает приложение', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    await initTelemetry();
    sentryCaptureMock.mockImplementation(() => {
      throw new Error('sentry-down');
    });
    expect(() => captureException(new Error('x'))).not.toThrow();
  });
});

describe('telemetryStatus', () => {
  it('возвращает корректный snapshot после инициализации', async () => {
    expect(telemetryStatus()).toEqual({ sentry: false, otel: false });
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    await initTelemetry();
    expect(telemetryStatus()).toEqual({ sentry: true, otel: false });
  });
});

describe('shutdownTelemetry', () => {
  it('no-op без активной телеметрии', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(sentryCloseMock).not.toHaveBeenCalled();
    expect(otelShutdownMock).not.toHaveBeenCalled();
  });

  it('закрывает Sentry и OTel когда активны', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    await initTelemetry();
    expect(telemetryStatus().otel).toBe(true);
    await shutdownTelemetry();
    expect(otelShutdownMock).toHaveBeenCalledTimes(1);
    expect(telemetryStatus().otel).toBe(false);
  });

  it('переживает падения при shutdown', async () => {
    process.env.SENTRY_DSN = 'https://abc@sentry.io/1';
    await initTelemetry();
    sentryCloseMock.mockRejectedValueOnce(new Error('close-fail'));
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(telemetryStatus().sentry).toBe(false);
  });
});
