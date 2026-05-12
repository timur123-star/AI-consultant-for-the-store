// Prometheus text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/).
// Конвертирует in-process snapshot из src/metrics.js в текст, который читают
// и Prometheus, и Grafana Agent, и VictoriaMetrics — то есть стандарт.
//
// Зачем: JSON /metrics удобен для глазного отладочного просмотра, но
// мониторинговые скрейперы говорят на Prometheus-формате. Делаем оба:
//   /metrics        — Prometheus text (стандартный путь для скрейпа)
//   /metrics.json   — JSON snapshot (для людей)

import type { MetricsSnapshot } from './types.js';

const VALID_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function sanitizeName(name: string): string {
  return VALID_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

function appCounter(out: string[], name: string, value: number, help?: string): void {
  const safe = sanitizeName(name);
  out.push(`# HELP ${safe} ${help || name}`);
  out.push(`# TYPE ${safe} counter`);
  out.push(`${safe} ${value}`);
}

interface SummaryStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}

function appSummary(out: string[], name: string, stats: SummaryStats, help?: string): void {
  // Используем summary с предрасчитанными квантилями. Histogram потребовал бы
  // буckets-конфигурации; для нашего use case (latency-only) summary удобнее.
  const safe = sanitizeName(name);
  out.push(`# HELP ${safe} ${help || `${name} (ms) latency summary`}`);
  out.push(`# TYPE ${safe} summary`);
  out.push(`${safe}{quantile="0.5"} ${stats.p50}`);
  out.push(`${safe}{quantile="0.95"} ${stats.p95}`);
  out.push(`${safe}{quantile="0.99"} ${stats.p99}`);
  out.push(`${safe}_count ${stats.count}`);
}

export function toPrometheus(snapshot: MetricsSnapshot): string {
  const out: string[] = [];

  // Process uptime — стандартное имя `process_uptime_seconds`.
  appCounter(
    out,
    'process_uptime_seconds',
    snapshot.uptime_seconds,
    'Process uptime in seconds since start'
  );

  for (const [name, value] of Object.entries(snapshot.counters || {})) {
    appCounter(out, name, value);
  }

  for (const [name, stats] of Object.entries(snapshot.latencies || {})) {
    appSummary(out, name, stats);
  }

  // Конец exposition должен оканчиваться newline'ом.
  return out.join('\n') + '\n';
}

export const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
