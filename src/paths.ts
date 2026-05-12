// Утилита для поиска файлов проекта (например, db/schema.sql) независимо от того,
// откуда запущен код: tsx из src/ (dev) или node из dist/src/ (после build).
//
// Поднимаемся по родительским директориям от заданной точки старта и проверяем,
// существует ли искомый относительный путь. Возвращаем первый существующий.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveRepoFile(startMetaUrl: string, relativePath: string): string {
  const startDir = path.dirname(fileURLToPath(startMetaUrl));
  let dir = startDir;
  // Поднимаемся максимум на 5 уровней — этого хватает и для src/, и для dist/src/.
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Фоллбэк — путь относительно стартовой директории; вызывающий получит ENOENT
  // с понятным путём, если файла действительно нет.
  return path.join(startDir, relativePath);
}
