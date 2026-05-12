// Утилита для обогащения data/catalog.json:
//   - добавляет image_url (placeholder с фирменными цветами по категориям)
//   - проставляет tags на основе описания (материал, цвет, повод)
//
// Запуск:  node scripts/augment-catalog.js
//
// Скрипт ИДЕМПОТЕНТЕН: повторный запуск перезатирает image_url и tags
// без дубликатов. Перезапиши data/catalog.json через `git add` после прогона.
import { readFile, writeFile } from 'node:fs/promises';
import { resolveRepoFile } from '../src/paths.js';

const catalogPath = resolveRepoFile(import.meta.url, 'data/catalog.json');

// Курированные Unsplash photo IDs по категориям. Все проверены (HTTP 200).
// URL формат: https://images.unsplash.com/photo-{ID}?w=800&q=80&auto=format&fit=crop
// Каждый SKU детерминированно получает один из этих ID — фото не меняются
// между перезапусками augment, но при изменении массива внутри категории
// SKU "перепрыгивают" на другое фото предсказуемо.
interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  price: number;
  category: string;
  image_url?: string | null;
  tags?: string[];
}

const UNSPLASH_BY_CATEGORY: Record<string, string[]> = {
  Сумки: [
    '1553062407-98eeb64c6a62',
    '1547949003-9792a18a2601',
    '1590874103328-eac38a683ce7',
    '1591561954557-26941169b49e',
    '1548036328-c9fa89d128fa',
    '1576566588028-4147f3842f27',
    '1594631252845-29fc4cc8cde9',
    '1573225342350-16731dd9bf3d',
    '1588850561407-ed78c282e89b',
  ],
  Кошельки: ['1627123424574-724758594e93', '1611652022419-a9419f74343d'],
  Ремни: ['1624222247344-550fb60583dc', '1605518216938-7c31b7b14ad0', '1553545204-4f7d339aa06a'],
  Перчатки: ['1610824352934-c10d87b700cc', '1551488831-00ddcb6c6bd3'],
  Аксессуары: ['1556905055-8f358a7a47b2', '1611652022419-a9419f74343d'],
  'Для дома и офиса': ['1517433670267-08bbd4be890f', '1456513080510-7bf3a84b82f8'],
  Путешествия: ['1565538810643-b5bdb714032a', '1581605405669-fcdf81165afa'],
  'Подарочные наборы': ['1513885535751-8b9238bd345a', '1607082348824-0a96f2a4b9da'],
};

// Тэги для loremflickr (резервный источник). Используется как fallback,
// если Unsplash CDN недоступен — в боте src/bot.js перехватывает ошибку
// sendPhoto и пробует загрузить альтернативный URL.
const LOREMFLICKR_TAG_BY_CATEGORY: Record<string, string> = {
  Сумки: 'leather,bag',
  Кошельки: 'leather,wallet',
  Ремни: 'leather,belt',
  Перчатки: 'leather,gloves',
  Аксессуары: 'leather,accessory',
  'Для дома и офиса': 'leather,desk',
  Путешествия: 'leather,travel',
  'Подарочные наборы': 'leather,gift',
};

// Простой стабильный хэш для индексирования (FNV-1a 32-bit).
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function imageUrlFor(item: CatalogItem): string {
  const pool = UNSPLASH_BY_CATEGORY[item.category];
  if (pool && pool.length) {
    const id = pool[hash32(item.sku) % pool.length];
    return `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;
  }
  // Fallback: loremflickr с lock-параметром — детерминированное фото.
  const tag = LOREMFLICKR_TAG_BY_CATEGORY[item.category] || 'leather';
  return `https://loremflickr.com/800/600/${tag}/?lock=${hash32(item.sku)}`;
}

// Простой эвристический тег-парсер. На проде вместо этого: вручную
// проставляются тегами в админке или генерируются NLP-классификатором.
const TAG_RULES = [
  { tag: 'мужское', re: /(мужск|мужчине|муж[.,]?)/i },
  { tag: 'женское', re: /(женск|женщине|жен[.,]?)/i },
  { tag: 'унисекс', re: /унисекс/i },
  { tag: 'подарок', re: /подар|сувенир|preset|preset/i },
  { tag: 'кожа crazy horse', re: /crazy horse/i },
  { tag: 'натуральная кожа', re: /натуральн.{1,15}кож|телячь|овчин|кожа/i },
  { tag: 'зима', re: /зим|тёпл|морозо|шерст|флис/i },
  { tag: 'офис', re: /офис|деловой|переговор|костюм|документ/i },
  { tag: 'путешествия', re: /путешеств|паспорт|поездк|туриз|чемодан/i },
  { tag: 'минимализм', re: /минимал|лаконичн|тонк/i },
  { tag: 'премиум', re: /латун|серебро|шёлк|премиум/i },
  { tag: 'чёрный', re: /чёрн/i },
  { tag: 'коричневый', re: /коричнев|коньяч|какао|шоколад/i },
  { tag: 'для ноутбука', re: /ноутбук|macbook|laptop/i },
];

function tagsFor(item: CatalogItem): string[] {
  const text = `${item.name} ${item.description}`;
  const tags = new Set<string>();
  for (const { tag, re } of TAG_RULES) {
    if (re.test(text)) tags.add(tag);
  }
  // Категория тоже становится тегом — для удобной фильтрации.
  tags.add(item.category.toLowerCase());
  // Ценовая корзина — упрощает запросы "до 3к", "от 10к".
  if (item.price < 2000) tags.add('бюджет');
  else if (item.price < 5000) tags.add('средний сегмент');
  else if (item.price < 10000) tags.add('премиум');
  else tags.add('люкс');
  return [...tags];
}

async function main() {
  const raw = await readFile(catalogPath, 'utf8');
  const items: CatalogItem[] = JSON.parse(raw);
  let touched = 0;
  for (const item of items) {
    const before = JSON.stringify({ image_url: item.image_url, tags: item.tags });
    item.image_url = imageUrlFor(item);
    item.tags = tagsFor(item);
    const after = JSON.stringify({ image_url: item.image_url, tags: item.tags });
    if (before !== after) touched += 1;
  }
  await writeFile(catalogPath, JSON.stringify(items, null, 2) + '\n', 'utf8');
  console.log(`augment-catalog: обработано ${items.length} позиций, изменено ${touched}.`);
}

main().catch((err) => {
  console.error('augment-catalog: ошибка:', err);
  process.exit(1);
});
