// Локальные embeddings через @huggingface/transformers (Transformers.js).
// Модель multilingual-e5-small (384 dim) хорошо работает с русским и английским
// и не требует внешнего API — после первого скачивания (~120 MB) работает оффлайн.
//
// Лениво загружаем pipeline один раз на процесс, чтобы не платить ~2с инициализации
// на каждом запросе.

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { config } from './config.js';
import { child } from './log.js';
import { getCached, setCached } from './embedding-cache.js';
import { recordLatency } from './metrics.js';

const log = child('embeddings');
let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

type EmbedKind = 'query' | 'passage';

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    log.info({ model: config.embeddingModel }, 'загружаю модель');
    embedderPromise = pipeline('feature-extraction', config.embeddingModel, {
      dtype: 'q8',
    }) as Promise<FeatureExtractionPipeline>;
  }
  return embedderPromise;
}

// e5-семейство ожидает префиксы "query:" для поисковых запросов
// и "passage:" для документов — это даёт заметный буст качества.
function withPrefix(text: string, kind: EmbedKind): string {
  return kind === 'query' ? `query: ${text}` : `passage: ${text}`;
}

async function embed(text: string, kind: EmbedKind): Promise<number[]> {
  const prefixed = withPrefix(text, kind);
  const cached = await getCached(prefixed);
  if (cached) return cached;
  const t0 = Date.now();
  const embedder = await getEmbedder();
  const output = await embedder(prefixed, {
    pooling: 'mean',
    normalize: true,
  });
  recordLatency('embedding_compute_ms', Date.now() - t0);
  const vector = Array.from(output.data as Iterable<number>);
  // Не ждём write — кэш чисто оптимизация, ошибка/задержка не должны влиять.
  void setCached(prefixed, vector);
  return vector;
}

export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, 'query');
}

export async function embedPassage(text: string): Promise<number[]> {
  return embed(text, 'passage');
}

// Прогревает модель при старте бота — первый пользовательский запрос не будет лагать.
export async function warmupEmbeddings(): Promise<void> {
  try {
    await embedQuery('тест');
    log.info('модель прогрета');
  } catch (err) {
    log.error({ err }, 'не удалось прогреть модель');
  }
}
