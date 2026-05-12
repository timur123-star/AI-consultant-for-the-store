import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  pickVariant,
  buildPromptForUser,
  activeVariants,
  listVariants,
  getVariant,
  registerVariant,
  _resetVariantsForTests,
} from '../src/prompt-ab.js';

const ORIGINAL_ENV = process.env.PROMPT_AB_VARIANTS;

beforeEach(() => {
  delete process.env.PROMPT_AB_VARIANTS;
  _resetVariantsForTests();
});

afterEach(() => {
  if (ORIGINAL_ENV !== undefined) process.env.PROMPT_AB_VARIANTS = ORIGINAL_ENV;
});

describe('listVariants', () => {
  it('содержит как минимум baseline / sales_focused / concise', () => {
    const ids = listVariants().map((v) => v.id);
    expect(ids).toContain('baseline');
    expect(ids).toContain('sales_focused');
    expect(ids).toContain('concise');
  });
  it('каждый variant имеет id, description, build', () => {
    for (const v of listVariants()) {
      expect(typeof v.id).toBe('string');
      expect(typeof v.description).toBe('string');
      expect(typeof v.build).toBe('function');
    }
  });
});

describe('activeVariants', () => {
  it('без env активен только baseline', () => {
    expect(activeVariants()).toEqual(['baseline']);
  });

  it('читает PROMPT_AB_VARIANTS через запятую', () => {
    process.env.PROMPT_AB_VARIANTS = 'baseline,sales_focused';
    _resetVariantsForTests();
    expect(activeVariants()).toEqual(['baseline', 'sales_focused']);
  });

  it('фильтрует неизвестные id', () => {
    process.env.PROMPT_AB_VARIANTS = 'baseline,unknown_xyz,concise';
    _resetVariantsForTests();
    expect(activeVariants()).toEqual(['baseline', 'concise']);
  });

  it('fallback на baseline если все id невалидны', () => {
    process.env.PROMPT_AB_VARIANTS = 'unknown1,unknown2';
    _resetVariantsForTests();
    expect(activeVariants()).toEqual(['baseline']);
  });

  it('lowercase + trim', () => {
    process.env.PROMPT_AB_VARIANTS = '  Baseline ,SALES_FOCUSED';
    _resetVariantsForTests();
    expect(activeVariants()).toEqual(['baseline', 'sales_focused']);
  });
});

describe('pickVariant', () => {
  it('с одним активным variant — всегда baseline', () => {
    expect(pickVariant(1).id).toBe('baseline');
    expect(pickVariant(999_999).id).toBe('baseline');
  });

  it('детерминированно для одного user_id', () => {
    process.env.PROMPT_AB_VARIANTS = 'baseline,sales_focused,concise';
    _resetVariantsForTests();
    const userId = 42;
    const a = pickVariant(userId).id;
    const b = pickVariant(userId).id;
    expect(a).toBe(b);
  });

  it('распределение более-менее равномерное на больших выборках', () => {
    process.env.PROMPT_AB_VARIANTS = 'baseline,sales_focused,concise';
    _resetVariantsForTests();
    const counts: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) {
      const v = pickVariant(i).id;
      counts[v] = (counts[v] || 0) + 1;
    }
    expect(Object.keys(counts).length).toBe(3);
    for (const cnt of Object.values(counts)) {
      // ~1000 на корзину, допустимое отклонение
      expect(cnt).toBeGreaterThan(700);
      expect(cnt).toBeLessThan(1300);
    }
  });
});

describe('buildPromptForUser', () => {
  it('возвращает prompt + variant id', () => {
    const result = buildPromptForUser(7, 'СТУЛЬЯ: товар 1');
    expect(result.variant).toBe('baseline');
    expect(result.prompt).toContain('КожаМастер');
    expect(result.prompt).toContain('СТУЛЬЯ: товар 1');
  });

  it('sales_focused добавляет CTA-направленные инструкции', () => {
    process.env.PROMPT_AB_VARIANTS = 'sales_focused';
    _resetVariantsForTests();
    const result = buildPromptForUser(7, 'X');
    expect(result.variant).toBe('sales_focused');
    expect(result.prompt).toMatch(/добавить в корзину|оформить/i);
  });

  it('concise производит короткий prompt с явной директивой о краткости', () => {
    process.env.PROMPT_AB_VARIANTS = 'concise';
    _resetVariantsForTests();
    const result = buildPromptForUser(7, 'X');
    expect(result.variant).toBe('concise');
    expect(result.prompt).toMatch(/телеграфно|без вступлений|3 предложения/i);
  });
});

describe('registerVariant', () => {
  it('позволяет добавить свой variant', () => {
    registerVariant({
      id: 'test_custom',
      description: 'test',
      build: () => 'CUSTOM PROMPT',
    });
    expect(getVariant('test_custom')?.id).toBe('test_custom');
    process.env.PROMPT_AB_VARIANTS = 'test_custom';
    _resetVariantsForTests();
    const result = buildPromptForUser(1, 'ctx');
    expect(result.variant).toBe('test_custom');
    expect(result.prompt).toBe('CUSTOM PROMPT');
  });
});
