// Утилиты для построения сообщений и инлайн-клавиатур.
// Вынесено из bot.js, чтобы бот-роутинг оставался читаемым.
import { Markup } from 'telegraf';
import type { Product } from './types.js';

// Только те поля Product, которые реально нужны карточке — упрощает вызов из тестов.
export type ProductForCard = Pick<
  Product,
  'id' | 'name' | 'description' | 'price' | 'category' | 'image_url'
>;

// Карточка одного товара: фото + подпись + кнопки "В корзину" и "Подробнее".
// Возвращает { method, args } — bot.js выбирает sendPhoto или sendMessage.
export function productCard(product: ProductForCard) {
  const priceText = `${product.price.toLocaleString('ru-RU')}₽`;
  const caption = [
    `*${escapeMd(product.name)}*`,
    `${priceText} · ${escapeMd(product.category)}`,
    '',
    escapeMd(product.description),
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`🛒 В корзину — ${priceText}`, `cart_add_${product.id}`)],
    [Markup.button.callback('📋 Подробнее', `info_${product.id}`)],
  ]);

  if (product.image_url) {
    return {
      method: 'photo',
      photo: product.image_url,
      caption,
      keyboard,
    };
  }
  return {
    method: 'message',
    text: caption,
    keyboard,
  };
}

// Клавиатура для нескольких товаров — компактная, по одному в строке.
export function productListKeyboard(products: Array<Pick<Product, 'id' | 'name' | 'price'>>) {
  if (!products.length) return undefined;
  const rows = products.map((p) => [
    Markup.button.callback(
      `🛒 ${truncate(p.name, 30)} — ${p.price.toLocaleString('ru-RU')}₽`,
      `cart_add_${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback('🧺 Открыть корзину', 'cart_view')]);
  return Markup.inlineKeyboard(rows);
}

// Клавиатура карусели: «◀ N/M ▶» навигация + «🛒 В корзину» + «↩️ Назад».
// callback_data формат:
//   carN_<token>_<idx>   — следующий товар
//   carP_<token>_<idx>   — предыдущий товар
//   cart_add_<id>        — добавить в корзину (совместимо с productCard)
//   carH                 — выйти в главный меню категорий
export interface CarouselKeyboardArgs {
  token: string;
  index: number;
  total: number;
  productId: number;
  withBack?: boolean;
}

export function carouselKeyboard({
  token,
  index,
  total,
  productId,
  withBack = true,
}: CarouselKeyboardArgs) {
  const idx = Math.max(0, Math.min(index, total - 1));
  const prevIdx = (idx - 1 + total) % total;
  const nextIdx = (idx + 1) % total;
  const navRow =
    total > 1
      ? [
          Markup.button.callback('◀', `carP_${token}_${prevIdx}`),
          Markup.button.callback(`${idx + 1} / ${total}`, 'noop'),
          Markup.button.callback('▶', `carN_${token}_${nextIdx}`),
        ]
      : [];
  const actionRow = [Markup.button.callback('🛒 В корзину', `cart_add_${productId}`)];
  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push(actionRow);
  if (withBack) rows.push([Markup.button.callback('↩️ К категориям', 'carH')]);
  rows.push([Markup.button.callback('🧺 Корзина', 'cart_view')]);
  return Markup.inlineKeyboard(rows);
}

// Caption для карусельной карточки. Добавляет title (напр. «Сумки — 6 позиций»)
// перед именем товара.
export function carouselCaption(
  product: Pick<Product, 'name' | 'price' | 'category' | 'description'> & {
    in_stock?: boolean;
  },
  { title = '' }: { title?: string } = {}
): string {
  const priceText = `${product.price.toLocaleString('ru-RU')}₽`;
  const lines = [];
  if (title) lines.push(`_${escapeMd(title)}_`, '');
  lines.push(`*${escapeMd(product.name)}*`);
  lines.push(`${priceText} · ${escapeMd(product.category)}`);
  lines.push('');
  lines.push(escapeMd(product.description));
  if (!product.in_stock) {
    lines.push('', '⚠️ *Нет в наличии*');
  }
  return lines.join('\n');
}

export interface CategoryGridItem {
  name: string;
  count: number;
  key: string;
}

// Клавиатура списка категорий (2 кнопки в ряд).
export function categoryGridKeyboard(categories: CategoryGridItem[]) {
  // categories: [{ name, count, key }]
  const rows: Array<ReturnType<typeof Markup.button.callback>[]> = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [];
    const a = categories[i];
    row.push(Markup.button.callback(`${a.name} · ${a.count}`, `cat_${a.key}`));
    if (categories[i + 1]) {
      const b = categories[i + 1];
      row.push(Markup.button.callback(`${b.name} · ${b.count}`, `cat_${b.key}`));
    }
    rows.push(row);
  }
  rows.push([
    Markup.button.callback('🌟 Популярное', 'featured'),
    Markup.button.callback('🧺 Корзина', 'cart_view'),
  ]);
  return Markup.inlineKeyboard(rows);
}

// Клавиатура для корзины: оформить заказ, очистить, продолжить выбор.
export function cartKeyboard(items: Array<Pick<Product, 'id' | 'name'>>) {
  const buttons: Array<ReturnType<typeof Markup.button.callback>[]> = [];
  if (items.length > 0) {
    buttons.push([Markup.button.callback('✅ Оформить заказ', 'cart_checkout')]);
    items
      .slice(0, 8)
      .forEach((p) =>
        buttons.push([
          Markup.button.callback(`❌ Убрать: ${truncate(p.name, 25)}`, `cart_rm_${p.id}`),
        ])
      );
    buttons.push([Markup.button.callback('🗑 Очистить корзину', 'cart_clear')]);
  }
  return Markup.inlineKeyboard(buttons);
}

// Клавиатура для менеджера: подтвердить / отметить отправленным / отменить.
export function managerOrderKeyboard(orderId: number) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Подтвердить', `mgr_confirm_${orderId}`),
      Markup.button.callback('📦 Отправлен', `mgr_ship_${orderId}`),
    ],
    [Markup.button.callback('❌ Отменить', `mgr_cancel_${orderId}`)],
  ]);
}

// Реэкспортируем STATUS_LABELS из order-status.js, чтобы старые потребители не ломались.
export { STATUS_LABELS } from './order-status.js';

export function formatCartSummary(
  products: Array<Pick<Product, 'name' | 'price'>>,
  totalPrice: number
): string {
  if (!products.length) {
    return 'Корзина пуста. Напиши что искать — добавлю товары сюда.';
  }
  const lines = products.map((p, i) => `${i + 1}. ${p.name} — ${p.price.toLocaleString('ru-RU')}₽`);
  return ['🧺 *Корзина*', '', ...lines, '', `Итого: *${totalPrice.toLocaleString('ru-RU')}₽*`].join(
    '\n'
  );
}

// Telegram MarkdownV2 требует экранирования ряда символов.
// Здесь используем "Markdown" (legacy) — экранируем только * _ ` [ ]
export function escapeMd(text: string | undefined | null): string {
  if (!text) return '';
  return text.replace(/([*_`[\]])/g, '\\$1');
}

export function truncate(text: string | undefined | null, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
