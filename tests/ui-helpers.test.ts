import { describe, it, expect } from 'vitest';
import { escapeMd, truncate, formatCartSummary } from '../src/ui.js';

describe('ui.escapeMd', () => {
  it('экранирует символы Markdown', () => {
    expect(escapeMd('hello *world*')).toBe('hello \\*world\\*');
    expect(escapeMd('a_b_c')).toBe('a\\_b\\_c');
    expect(escapeMd('`code` and [link]')).toBe('\\`code\\` and \\[link\\]');
  });

  it('пустая/undefined строка → пустая строка', () => {
    expect(escapeMd('')).toBe('');
    expect(escapeMd(undefined)).toBe('');
    expect(escapeMd(null)).toBe('');
  });

  it('текст без спецсимволов остаётся как есть', () => {
    expect(escapeMd('Просто текст 123')).toBe('Просто текст 123');
  });
});

describe('ui.truncate', () => {
  it('короткий текст не меняется', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('длинный текст обрезается с многоточием', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });

  it('пустая/undefined строка → пустая строка', () => {
    expect(truncate('', 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
  });
});

describe('ui.formatCartSummary', () => {
  it('пустая корзина — friendly сообщение', () => {
    const out = formatCartSummary([], 0);
    expect(out.toLowerCase()).toContain('корзина пуста');
  });

  it('форматирует список + итог', () => {
    const out = formatCartSummary(
      [
        { name: 'Кошелёк', price: 3500 },
        { name: 'Ремень', price: 4200 },
      ],
      7700
    );
    expect(out).toContain('1. Кошелёк');
    expect(out).toContain('2. Ремень');
    expect(out).toContain('Итого');
    expect(out).toContain('7\u00a0700'); // ru-RU группировка
  });
});
