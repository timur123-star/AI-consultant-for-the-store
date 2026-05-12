import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveRepoFile } from '../src/paths.js';

describe('resolveRepoFile', () => {
  it('находит db/schema.sql от src/ (dev-режим, tsx)', () => {
    const url = new URL('../src/bootstrap.ts', import.meta.url).href;
    const p = resolveRepoFile(url, 'db/schema.sql');
    expect(p).toMatch(/db\/schema\.sql$/);
    expect(existsSync(p)).toBe(true);
  });

  it('находит data/catalog.json от scripts/ (dev-режим)', () => {
    const url = new URL('../scripts/index-catalog.ts', import.meta.url).href;
    const p = resolveRepoFile(url, 'data/catalog.json');
    expect(p).toMatch(/data\/catalog\.json$/);
    expect(existsSync(p)).toBe(true);
  });

  it('находит db/schema.sql от dist/src/ (прод-режим, после tsc)', () => {
    // Симулируем сценарий: код запущен из dist/src/bootstrap.js, корень проекта на 2 уровня выше.
    const url = new URL('../dist/src/bootstrap.js', import.meta.url).href;
    const p = resolveRepoFile(url, 'db/schema.sql');
    expect(p).toMatch(/db\/schema\.sql$/);
    expect(existsSync(p)).toBe(true);
  });

  it('возвращает фоллбэк-путь когда файл не найден', () => {
    const url = new URL('../src/bootstrap.ts', import.meta.url).href;
    const p = resolveRepoFile(url, 'nonexistent/file.txt');
    expect(p).toMatch(/nonexistent\/file\.txt$/);
    expect(existsSync(p)).toBe(false);
  });
});
