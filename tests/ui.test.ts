import { describe, it, expect } from 'vitest';
import {
  productCard,
  productListKeyboard,
  cartKeyboard,
  managerOrderKeyboard,
  formatCartSummary,
  STATUS_LABELS,
  carouselKeyboard,
  carouselCaption,
  categoryGridKeyboard,
} from '../src/ui.js';

interface InlineKbButton {
  text: string;
  callback_data?: string;
}
interface InlineKb {
  reply_markup: { inline_keyboard: InlineKbButton[][] };
}

const sample = {
  id: 7,
  sku: 'BAG-001',
  name: 'Сумка-тоут «Москва»',
  category: 'Сумки',
  price: 8900,
  description: 'Просторный шоппер из коричневой кожи',
  image_url: 'https://placehold.co/800x600/8B4513/FFFFFF.jpg?text=BAG-001',
};

describe('productCard', () => {
  it('возвращает photo-карточку когда есть image_url', () => {
    const card = productCard(sample);
    expect(card.method).toBe('photo');
    expect(card.photo).toBe(sample.image_url);
    expect(card.caption).toContain('Сумка-тоут');
    // toLocaleString('ru-RU') вставляет NBSP (U+00A0) между разрядами.
    expect(card.caption).toMatch(/8[\s\u00a0]900₽/);
    expect(card.caption).toContain('Просторный шоппер');
    expect(card.keyboard).toBeDefined();
  });

  it('возвращает message-карточку когда нет image_url', () => {
    const card = productCard({ ...sample, image_url: null });
    expect(card.method).toBe('message');
    expect(card.text).toContain('Сумка-тоут');
    expect(card.keyboard).toBeDefined();
  });
});

describe('productListKeyboard', () => {
  it('возвращает undefined для пустого списка', () => {
    expect(productListKeyboard([])).toBeUndefined();
  });

  it('содержит кнопку открытия корзины как последнюю строку', () => {
    const kb = productListKeyboard([sample]) as unknown as InlineKb;
    // Telegraf Markup.inlineKeyboard возвращает объект с reply_markup.inline_keyboard.
    const rows = kb.reply_markup.inline_keyboard;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const lastRow = rows[rows.length - 1];
    expect(lastRow[0].text).toMatch(/корзину/i);
  });
});

describe('cartKeyboard', () => {
  it('содержит кнопку оформления для непустой корзины', () => {
    const kb = cartKeyboard([sample]) as unknown as InlineKb;
    const rows = kb.reply_markup.inline_keyboard;
    expect(rows[0][0].text).toMatch(/Оформить/);
    expect(rows[rows.length - 1][0].text).toMatch(/Очистить/);
  });

  it('пустая клавиатура для пустой корзины', () => {
    const kb = cartKeyboard([]) as unknown as InlineKb;
    expect(kb.reply_markup.inline_keyboard).toEqual([]);
  });
});

describe('managerOrderKeyboard', () => {
  it('возвращает 3 действия с правильным order ID', () => {
    const kb = managerOrderKeyboard(42) as unknown as InlineKb;
    const flat = kb.reply_markup.inline_keyboard.flat();
    const datas = flat.map((b) => b.callback_data);
    expect(datas).toEqual(['mgr_confirm_42', 'mgr_ship_42', 'mgr_cancel_42']);
  });
});

describe('formatCartSummary', () => {
  it('форматирует список + итог', () => {
    const items = [
      { id: 1, name: 'A', price: 1000 },
      { id: 2, name: 'B', price: 2500 },
    ];
    const text = formatCartSummary(items, 3500);
    expect(text).toContain('1. A');
    expect(text).toContain('2. B');
    expect(text).toMatch(/3[\s\u00a0]500₽/);
  });

  it('сообщение для пустой корзины', () => {
    expect(formatCartSummary([], 0)).toMatch(/пуста/i);
  });
});

describe('STATUS_LABELS', () => {
  it('содержит все статусы заказа', () => {
    expect(STATUS_LABELS.new).toBeDefined();
    expect(STATUS_LABELS.confirmed).toBeDefined();
    expect(STATUS_LABELS.shipped).toBeDefined();
    expect(STATUS_LABELS.delivered).toBeDefined();
    expect(STATUS_LABELS.cancelled).toBeDefined();
  });
});

describe('carouselKeyboard', () => {
  it('строит навигацию prev/next с циклическим переходом', () => {
    const kb = carouselKeyboard({
      token: 'abcd1234',
      index: 0,
      total: 5,
      productId: 7,
    }) as unknown as InlineKb;
    const rows = kb.reply_markup.inline_keyboard;
    // первый ряд — навигация
    const navRow = rows[0];
    expect(navRow).toHaveLength(3);
    expect(navRow[0].callback_data).toBe('carP_abcd1234_4'); // wraps to last
    expect(navRow[1].text).toBe('1 / 5');
    expect(navRow[2].callback_data).toBe('carN_abcd1234_1');
  });

  it('не показывает навигацию, если total=1', () => {
    const kb = carouselKeyboard({
      token: 't',
      index: 0,
      total: 1,
      productId: 1,
    }) as unknown as InlineKb;
    const rows = kb.reply_markup.inline_keyboard;
    // первый ряд — «В корзину», без prev/next
    expect(rows[0][0].callback_data).toBe('cart_add_1');
  });

  it('включает кнопку «В корзину» с правильным product_id', () => {
    const kb = carouselKeyboard({
      token: 't',
      index: 1,
      total: 3,
      productId: 42,
    }) as unknown as InlineKb;
    const flat = kb.reply_markup.inline_keyboard.flat();
    const cart = flat.find((b) => b.callback_data === 'cart_add_42');
    expect(cart).toBeDefined();
  });
});

describe('carouselCaption', () => {
  const sample = {
    id: 1,
    sku: 'BAG-001',
    name: 'Сумка-тоут',
    category: 'Сумки',
    price: 8900,
    description: 'Описание',
    in_stock: true,
  };

  it('включает title в italic перед именем', () => {
    const cap = carouselCaption(sample, { title: 'Подборка на зиму' });
    expect(cap).toMatch(/_Подборка на зиму_/);
    expect(cap).toMatch(/\*Сумка-тоут\*/);
  });

  it('помечает отсутствие в наличии', () => {
    const cap = carouselCaption({ ...sample, in_stock: false });
    expect(cap).toContain('Нет в наличии');
  });
});

describe('categoryGridKeyboard', () => {
  it('раскладывает кнопки по 2 в ряд + футер', () => {
    const cats = [
      { name: 'Сумки', count: 10, key: 'abc' },
      { name: 'Кошельки', count: 5, key: 'def' },
      { name: 'Ремни', count: 3, key: 'ghi' },
    ];
    const kb = categoryGridKeyboard(cats) as unknown as InlineKb;
    const rows = kb.reply_markup.inline_keyboard;
    // 3 категории → 2 ряда (2+1) + 1 ряд футера
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
    expect(rows[0][0].callback_data).toBe('cat_abc');
    expect(rows[0][0].text).toContain('Сумки');
    expect(rows[0][0].text).toContain('10');
    // Последний ряд — футер (Популярное и Корзина)
    const footer = rows[2];
    expect(footer.map((b) => b.callback_data)).toEqual(['featured', 'cart_view']);
  });
});

describe('base64url encoding категорий', () => {
  it('влезает в 64 байта callback_data для самых длинных категорий', () => {
    const longest = ['Подарочные наборы', 'Для дома и офиса', 'Путешествия'];
    for (const name of longest) {
      const encoded = Buffer.from(name, 'utf8').toString('base64url');
      const callbackData = `cat_${encoded}`;
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
      // round-trip
      expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(name);
    }
  });
});
