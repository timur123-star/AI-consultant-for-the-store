import { describe, it, expect } from 'vitest';
import {
  VALID_STATUSES,
  VALID_STATUS_SET,
  STATUS_LABELS,
  statusUpdateMessage,
} from '../src/order-status.js';

describe('order-status', () => {
  it('VALID_STATUSES содержит ожидаемый набор', () => {
    expect(VALID_STATUSES).toEqual([
      'new',
      'pending_payment',
      'paid',
      'confirmed',
      'shipped',
      'delivered',
      'cancelled',
    ]);
  });

  it('VALID_STATUS_SET — Set с теми же значениями', () => {
    for (const s of VALID_STATUSES) expect(VALID_STATUS_SET.has(s)).toBe(true);
    expect(VALID_STATUS_SET.has('invalid')).toBe(false);
  });

  it('STATUS_LABELS определены для каждого статуса', () => {
    for (const s of VALID_STATUSES) {
      expect(STATUS_LABELS[s]).toBeTruthy();
    }
  });

  it('statusUpdateMessage генерит понятный текст для confirmed', () => {
    const msg = statusUpdateMessage(42, 'confirmed');
    expect(msg).toContain('#42');
    expect(msg.toLowerCase()).toContain('подтверждён');
  });

  it('statusUpdateMessage для shipped/cancelled/delivered отличаются', () => {
    const shipped = statusUpdateMessage(1, 'shipped');
    const cancelled = statusUpdateMessage(1, 'cancelled');
    const delivered = statusUpdateMessage(1, 'delivered');
    expect(shipped).not.toBe(cancelled);
    expect(shipped).not.toBe(delivered);
    expect(cancelled).not.toBe(delivered);
  });

  it('statusUpdateMessage для неизвестного статуса возвращает дефолтный шаблон', () => {
    const msg = statusUpdateMessage(7, 'unknown');
    expect(msg).toContain('#7');
  });
});
