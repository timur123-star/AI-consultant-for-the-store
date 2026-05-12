import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, FALLBACK_REPLY, WELCOME_TEXT, STORE_INFO } from '../src/prompt.js';

describe('prompt.buildSystemPrompt', () => {
  it('подставляет контекст товаров в системный промпт', () => {
    const productContext = '1. Сумка-тоут «Москва» — 7500₽ (категория: Сумки, sku: TOTE-001)';
    const prompt = buildSystemPrompt(productContext);

    expect(prompt).toContain(productContext);
    expect(prompt).toContain('КожаМастер');
    expect(prompt).toContain('Доступные товары');
  });

  it('включает информацию о магазине (доставка, оплата)', () => {
    const prompt = buildSystemPrompt('');
    expect(prompt).toContain(STORE_INFO);
    expect(prompt).toContain('СДЭК');
    expect(prompt).toContain('Возврат');
  });

  it('содержит правила запрещающие выдумывать цены и SKU', () => {
    const prompt = buildSystemPrompt('');
    // Главная анти-галлюцинация защита — ключевое требование для портфолио-проекта.
    expect(prompt).toMatch(/НЕ выдумывай|ТОЛЬКО из контекста/);
  });

  it('обрезает trailing whitespace', () => {
    const prompt = buildSystemPrompt('x');
    expect(prompt).toBe(prompt.trim());
  });
});

describe('prompt константы', () => {
  it('FALLBACK_REPLY предлагает альтернативные действия', () => {
    expect(FALLBACK_REPLY).toContain('переформулировать');
    expect(FALLBACK_REPLY).toContain('/catalog');
    expect(FALLBACK_REPLY).toContain('менеджер');
  });

  it('WELCOME_TEXT даёт примеры запросов на естественном языке', () => {
    expect(WELCOME_TEXT).toContain('КожаМастер');
    // Должен показать минимум 2 примера запроса — обучает пользователя.
    const examples = WELCOME_TEXT.split('\n').filter((l) => l.trim().startsWith('•'));
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });
});
