// Применяет db/schema.sql к базе из DATABASE_URL.
// Идемпотентно: использует CREATE ... IF NOT EXISTS.
import { readFile } from 'node:fs/promises';
import { pool, closeDb } from '../src/db.js';
import { waitForDb } from '../src/wait-for-db.js';
import { child } from '../src/log.js';
import { resolveRepoFile } from '../src/paths.js';

const log = child('migrate');

async function main(): Promise<void> {
  await waitForDb();
  const schemaPath = resolveRepoFile(import.meta.url, 'db/schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  log.info({ schemaPath }, 'применяю схему');
  await pool.query(sql);
  log.info('готово');
}

main()
  .catch((err: unknown) => {
    log.fatal({ err }, 'ошибка миграции');
    process.exitCode = 1;
  })
  .finally(closeDb);
