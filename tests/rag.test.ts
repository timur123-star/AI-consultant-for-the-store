import { describe, it, expect } from 'vitest';
import { formatProductsForPrompt } from '../src/rag.js';

describe('rag.formatProductsForPrompt', () => {
  it('возвращает читаемое описание при наличии товаров', () => {
    const products = [
      {
        sku: 'TOTE-001',
        name: 'Сумка-тоут «Москва»',
        description: 'Просторная сумка на каждый день',
        price: 7500,
        category: 'Сумки',
      },
      {
        sku: 'WALLET-002',
        name: 'Кардхолдер «Минимум»',
        description: 'Компактный держатель для 4 карт',
        price: 1900,
        category: 'Кошельки',
      },
    ];

    const text = formatProductsForPrompt(products);

    expect(text).toContain('1. Сумка-тоут «Москва»');
    expect(text).toContain('7500₽');
    expect(text).toContain('sku: TOTE-001');
    expect(text).toContain('2. Кардхолдер «Минимум»');
    expect(text).toContain('1900₽');
    expect(text).toContain('Просторная сумка');
  });

  it('возвращает понятный текст когда товаров нет', () => {
    const text = formatProductsForPrompt([]);
    expect(text.toLowerCase()).toContain('не найдено');
  });

  it('нумерует товары начиная с 1', () => {
    const products = Array.from({ length: 3 }, (_, i) => ({
      sku: `S-${i}`,
      name: `Товар ${i}`,
      description: 'desc',
      price: 100,
      category: 'Прочее',
    }));
    const text = formatProductsForPrompt(products);
    expect(text).toMatch(/^1\./);
    expect(text).toContain('\n2.');
    expect(text).toContain('\n3.');
  });
});
