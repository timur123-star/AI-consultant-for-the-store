import { describe, it, expect, beforeEach } from 'vitest';
import { inc, recordLatency, snapshot, reset } from '../src/metrics.js';

beforeEach(() => {
  reset();
});

describe('metrics', () => {
  it('inc увеличивает счётчик', () => {
    inc('messages_total');
    inc('messages_total', 5);
    expect(snapshot().counters.messages_total).toBe(6);
  });

  it('recordLatency пишет p50/p95/p99', () => {
    for (let i = 1; i <= 100; i += 1) recordLatency('llm_ms', i);
    const lat = snapshot().latencies.llm_ms;
    expect(lat.count).toBe(100);
    expect(lat.p50).toBeGreaterThan(40);
    expect(lat.p50).toBeLessThanOrEqual(60);
    expect(lat.p95).toBeGreaterThanOrEqual(90);
    expect(lat.p99).toBeGreaterThanOrEqual(95);
  });

  it('snapshot включает uptime_seconds и timestamp', () => {
    const s = snapshot();
    expect(typeof s.uptime_seconds).toBe('number');
    expect(typeof s.timestamp).toBe('string');
    expect(new Date(s.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('latency буфер не растёт неограниченно', () => {
    for (let i = 0; i < 2000; i += 1) recordLatency('x', i);
    const lat = snapshot().latencies.x;
    expect(lat.count).toBeLessThanOrEqual(1024);
  });

  it('reset обнуляет всё', () => {
    inc('a');
    recordLatency('b', 10);
    reset();
    const s = snapshot();
    expect(s.counters).toEqual({});
    expect(s.latencies).toEqual({});
  });
});
