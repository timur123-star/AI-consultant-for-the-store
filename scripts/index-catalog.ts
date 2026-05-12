// Индексация каталога: читает data/catalog.json, считает embeddings,
// делает UPSERT в таблицу products. Идемпотентен по sku.
//
// Запуск:  npm run reindex
import { readFile } from 'node:fs/promises';
import { pool, query, toPgVector, closeDb } from '../src/db.js';
import { resolveRepoFile } from '../src/paths.js';
import { embedPassage } from '../src/embeddings.js';
import { waitForDb } from '../src/wait-for-db.js';
import { child } from '../src/log.js';

const log = child('index');

interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  price: number;
  category: string;
  image_url?: string | null;
  tags?: string[];
}

export async function indexCatalog(catalogPath?: string): Promise<number> {
  await waitForDb();
  const file = catalogPath || resolveRepoFile(import.meta.url, 'data/catalog.json');
  const raw = await readFile(file, 'utf8');
  const items: CatalogItem[] = JSON.parse(raw);

  // Проверяем что pgvector установлен, и применяем схему если ещё нет —
  // делает скрипт самодостаточным для первого запуска.
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  let processed = 0;
  for (const item of items) {
    // Теги включаем в текст для embedding — это даёт дополнительный сигнал поиску
    // для запросов вроде "подарок мужчине" и "для путешествий".
    const tagsText = item.tags?.length ? `Теги: ${item.tags.join(', ')}. ` : '';
    const text = `${item.name}. Категория: ${item.category}. ${tagsText}${item.description}`;
    const vector = await embedPassage(text);
    await query(
      `INSERT INTO products (sku, name, description, price, category, in_stock, image_url, tags, embedding, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7::text[], $8::vector, NOW())
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             price = EXCLUDED.price,
             category = EXCLUDED.category,
             in_stock = TRUE,
             image_url = EXCLUDED.image_url,
             tags = EXCLUDED.tags,
             embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
      [
        item.sku,
        item.name,
        item.description,
        item.price,
        item.category,
        item.image_url || null,
        item.tags || [],
        toPgVector(vector),
      ]
    );
    processed += 1;
    if (processed % 10 === 0) {
      log.info({ processed, total: items.length }, 'прогресс индексации');
    }
  }
  log.info({ processed }, 'индексация завершена');
  return processed;
}

// Запуск как самостоятельный скрипт
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  indexCatalog(undefined)
    .catch((err) => {
      log.fatal({ err }, 'ошибка индексации');
      process.exitCode = 1;
    })
    .finally(closeDb);
}
