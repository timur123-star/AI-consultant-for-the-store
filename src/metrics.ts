// Лёгкие in-process метрики без зависимостей. Один HashMap-счётчик и
// бакеты для latency. /metrics endpoint выдаёт это в текстовом виде,
// удобном для глазами или для скрейпа.
import type { MetricsSnapshot } from './types.js';

const counters: Record<string, number> = Object.create(null);
const latencies: Record<string, number[]> = Object.create(null);

export function inc(name: string, by = 1): void {
  counters[name] = (counters[name] || 0) + by;
}

// Записывает latency в миллисекундах. Хранит до 1024 последних значений
// per-key, чтобы не разрастаться неограниченно.
export function recordLatency(name: string, ms: number): void {
  const buf = latencies[name] || (latencies[name] = []);
  buf.push(ms);
  if (buf.length > 1024) buf.shift();
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function snapshot(): MetricsSnapshot {
  const lat: MetricsSnapshot['latencies'] = {};
  for (const [name, values] of Object.entries(latencies)) {
    lat[name] = {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
    };
  }
  return {
    counters: { ...counters },
    latencies: lat,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

// Для тестов.
export function reset(): void {
  for (const k of Object.keys(counters)) delete counters[k];
  for (const k of Object.keys(latencies)) delete latencies[k];
}
