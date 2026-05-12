// A/B-тестирование системного промпта.
//
// Идея: держим несколько вариантов system-prompt'а, детерминированно
// распределяем пользователей по варианту (по userId), и каждый ответ LLM
// помечается метрикой `prompt_variant_<id>_total` + latency-семплом
// `llm_ms_variant_<id>`.
//
// Цель — измерять разные стили формулировок без code-deploy: добавил
// вариант, выкатил, через сутки посмотрел /metrics и решил, какой
// промпт оставить.
//
// Распределение — детерминированное по userId (одинаковый user всегда
// получает один и тот же variant), чтобы:
//   1) опыт пользователя был стабильным между сессиями;
//   2) можно было корректно агрегировать метрики per-variant.
//
// Без env-переменных активен только один вариант — `baseline`. Чтобы
// включить A/B-тест, задай `PROMPT_AB_VARIANTS=baseline,sales_focused`
// (через запятую). Неизвестные имена игнорируются.

import { createHash } from 'node:crypto';
import { STORE_INFO } from './prompt.js';
import { child } from './log.js';

const log = child('prompt-ab');

export type PromptVariantId = string;

export interface PromptVariant {
  /** Уникальный идентификатор для метрик и логов (snake_case). */
  id: PromptVariantId;
  /** Короткое описание стиля, чтобы в коде было видно за что отвечает вариант. */
  description: string;
  /** Билдер system-prompt'а: получает productContext, отдаёт готовый prompt. */
  build: (productContext: string) => string;
}

/**
 * Реестр вариантов. Регистрировать через `registerVariant`, чтобы не плодить
 * глобалы. Содержит дефолтные варианты — продакшен может оставить только
 * baseline через `PROMPT_AB_VARIANTS=baseline`.
 */
const VARIANTS = new Map<PromptVariantId, PromptVariant>();

function rules(common: string[]): string {
  return common.map((r) => `- ${r}`).join('\n');
}

function baselineBuild(productContext: string): string {
  return `Ты — приветливый и компетентный консультант магазина «КожаМастер».
Твоя задача — помочь клиенту найти подходящий товар, ответить на вопросы и довести до покупки.

Правила:
${rules([
  'Отвечай на русском, естественно, без шаблонных фраз.',
  'Если в контексте есть подходящие товары — рекомендуй их, кратко объясняя почему подходят.',
  'Если товаров нет — НЕ выдумывай. Скажи что прямо сейчас не нашёл и предложи связаться с менеджером, либо переформулировать запрос.',
  'Цены, sku и характеристики бери ТОЛЬКО из контекста ниже. Если данных нет — так и скажи.',
  'Не используй markdown-таблицы, эмодзи допустимы, но скромно (1-2 на сообщение).',
  'Длина ответа: 2-5 коротких абзацев максимум.',
])}

Информация о магазине:
${STORE_INFO}

Доступные товары по запросу клиента (отсортированы по релевантности):
${productContext}`.trim();
}

function salesBuild(productContext: string): string {
  return `Ты — sales-консультант магазина «КожаМастер». Дружелюбный, но проактивный:
после ответа на вопрос всегда мягко двигаешь клиента к покупке.

Правила:
${rules([
  'Отвечай на русском, разговорно. Используй вопросы по ходу диалога — «что важнее: вместимость или вес?».',
  'Рекомендуй максимум 2 SKU за раз — слишком большой выбор парализует.',
  'После рекомендации СВОЁ предложение закончи мягким CTA: «добавить в корзину?» или «оформить?».',
  'Если в контексте товаров нет — НЕ выдумывай. Предложи менеджера или /catalog.',
  'Цены и характеристики — только из контекста.',
  'Эмодзи можно — 1-3 на сообщение для тона. Никаких markdown-таблиц.',
  'Длина: 2-4 коротких абзаца.',
])}

Информация о магазине:
${STORE_INFO}

Доступные товары:
${productContext}`.trim();
}

function conciseBuild(productContext: string): string {
  return `Ты — краткий консультант магазина «КожаМастер». Никаких лишних слов.

Правила:
${rules([
  'Отвечай на русском, телеграфно. Один абзац, максимум 3 предложения.',
  'Сразу название, цена, главное преимущество. Без вступлений и приветствий.',
  'Максимум 3 SKU за раз, в формате «название — цена — почему стоит».',
  'Если товаров нет — одна строка: «нет в каталоге, напиши менеджеру».',
  'Никаких эмодзи, никакого markdown, никаких таблиц.',
  'Цены и характеристики — только из контекста.',
])}

Информация о магазине:
${STORE_INFO}

Товары:
${productContext}`.trim();
}

// Регистрируем дефолтные варианты.
VARIANTS.set('baseline', {
  id: 'baseline',
  description: 'Сбалансированный консультант, текущий продакшен-вариант.',
  build: baselineBuild,
});
VARIANTS.set('sales_focused', {
  id: 'sales_focused',
  description: 'Более активные CTA, дробный диалог с уточняющими вопросами.',
  build: salesBuild,
});
VARIANTS.set('concise', {
  id: 'concise',
  description: 'Минимум воды, телеграфный стиль, удобно с мобильного.',
  build: conciseBuild,
});

/** Регистрирует пользовательский variant. Если id уже существует — переопределяет. */
export function registerVariant(variant: PromptVariant): void {
  VARIANTS.set(variant.id, variant);
}

/**
 * Сбрасывает реестр к дефолтному состоянию. Для тестов и для возможности
 * пересчитать активный список при изменении env.
 */
export function _resetVariantsForTests(): void {
  activeVariantIds = null;
}

let activeVariantIds: PromptVariantId[] | null = null;

function parseActiveVariants(): PromptVariantId[] {
  const raw = (process.env.PROMPT_AB_VARIANTS || '').trim();
  if (!raw) return ['baseline'];
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((id) => {
      const exists = VARIANTS.has(id);
      if (!exists) log.warn({ id }, 'неизвестный variant в PROMPT_AB_VARIANTS, пропускаю');
      return exists;
    });
  if (!ids.length) {
    log.warn('PROMPT_AB_VARIANTS не содержит валидных variant id, fallback на baseline');
    return ['baseline'];
  }
  return ids;
}

/** Текущий активный список variant id (мемоизируется при первом обращении). */
export function activeVariants(): PromptVariantId[] {
  if (!activeVariantIds) {
    activeVariantIds = parseActiveVariants();
  }
  return activeVariantIds;
}

/**
 * Детерминированно выбирает variant для userId через sha256 → modulo по
 * количеству активных вариантов. Один и тот же user всегда получает один
 * и тот же variant до следующего деплоя.
 *
 * Если активен только `baseline` (по умолчанию) — всегда возвращает его.
 */
export function pickVariant(userId: number | string): PromptVariant {
  const ids = activeVariants();
  if (ids.length === 1) {
    return VARIANTS.get(ids[0]) || VARIANTS.get('baseline')!;
  }
  const hash = createHash('sha256').update(String(userId)).digest();
  // первые 4 байта как uint32 → modulo
  const bucket = hash.readUInt32BE(0) % ids.length;
  const chosen = ids[bucket];
  return VARIANTS.get(chosen) || VARIANTS.get('baseline')!;
}

/** Возвращает variant по id или undefined. Полезно для тестов и /analytics. */
export function getVariant(id: PromptVariantId): PromptVariant | undefined {
  return VARIANTS.get(id);
}

/**
 * Полный список зарегистрированных вариантов (для /docs и тестов). Включает
 * неактивные — не путать с `activeVariants()`.
 */
export function listVariants(): readonly PromptVariant[] {
  return Array.from(VARIANTS.values());
}

/**
 * Высокоуровневый билдер — выбирает variant для userId и сразу формирует
 * system-prompt. Возвращает и сам prompt, и id выбранного варианта (для
 * метрик и логирования в conversations).
 */
export function buildPromptForUser(
  userId: number | string,
  productContext: string
): { prompt: string; variant: PromptVariantId } {
  const variant = pickVariant(userId);
  return { prompt: variant.build(productContext), variant: variant.id };
}
