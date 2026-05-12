import { describe, it, expect } from 'vitest';
import { toPrometheus, PROM_CONTENT_TYPE } from '../src/prom.js';

describe('toPrometheus', () => {
  it('конвертирует counters в формат counter', () => {
    const text = toPrometheus({
      counters: { messages_total: 42, errors_total: 1 },
      latencies: {},
      uptime_seconds: 10,
      timestamp: 'x',
    });
    expect(text).toContain('# TYPE messages_total counter');
    expect(text).toContain('messages_total 42');
    expect(text).toContain('# TYPE errors_total counter');
    expect(text).toContain('errors_total 1');
  });

  it('добавляет uptime как process_uptime_seconds', () => {
    const text = toPrometheus({
      counters: {},
      latencies: {},
      uptime_seconds: 123,
      timestamp: 'x',
    });
    expect(text).toContain('process_uptime_seconds 123');
  });

  it('конвертирует latencies в summary с квантилями', () => {
    const text = toPrometheus({
      counters: {},
      latencies: {
        message_ms: { count: 100, p50: 12, p95: 50, p99: 99 },
      },
      uptime_seconds: 0,
      timestamp: 'x',
    });
    expect(text).toContain('# TYPE message_ms summary');
    expect(text).toContain('message_ms{quantile="0.5"} 12');
    expect(text).toContain('message_ms{quantile="0.95"} 50');
    expect(text).toContain('message_ms{quantile="0.99"} 99');
    expect(text).toContain('message_ms_count 100');
  });

  it('санитизирует невалидные имена', () => {
    const text = toPrometheus({
      counters: { 'bad-name.with:dots': 1 },
      latencies: {},
      uptime_seconds: 0,
      timestamp: 'x',
    });
    // dots, colons, и dashes должны быть заменены или сохранены по правилам.
    // : разрешён, . и - нет.
    expect(text).toContain('bad_name_with:dots 1');
  });

  it('оканчивается newline', () => {
    const text = toPrometheus({
      counters: { x: 1 },
      latencies: {},
      uptime_seconds: 0,
      timestamp: 'x',
    });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('экспортирует валидный Content-Type для Prometheus', () => {
    expect(PROM_CONTENT_TYPE).toContain('text/plain');
    expect(PROM_CONTENT_TYPE).toContain('version=0.0.4');
  });
});
