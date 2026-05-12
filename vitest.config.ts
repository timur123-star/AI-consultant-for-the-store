import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'html'],
      // Считаем покрытие по всему src/, даже если файл не импортирован тестами явно
      // — это даёт честную картину «что покрыто, а что нет».
      include: ['src/**/*.ts'],
      // Исключаем чистые точки входа и интеграционные обёртки —
      // их разумно тестировать end-to-end, а не unit-тестами.
      exclude: ['src/bot.ts', 'src/bootstrap.ts', 'src/wait-for-db.ts'],
    },
  },
});
