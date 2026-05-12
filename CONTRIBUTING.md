# Contributing

Спасибо за интерес к проекту. Этот документ — короткий гайд, как вносить изменения.

## Setup

```bash
git clone https://github.com/timur123-star/AI-consultant-for-the-store
cd AI-consultant-for-the-store
npm install
docker compose up -d        # Postgres + Redis
cp .env.example .env        # заполни значения
npm run migrate
npm run reindex
npm start
```

Подробности — в [README](README.md).

## Что важно при правках

1. **Линт.** `npm run lint` — синтаксическая проверка всех модулей. Должен проходить.
2. **Тесты.** `npm test` — должны быть зелёными. При изменении бизнес-логики добавь/обнови тест в `tests/`.
3. **Логи.** Используй `child('module-name')` из `src/log.ts`. Не пиши `console.log`.
4. **Без секретов в коде.** Все ключи — через env. `dotenv` подхватит `.env` локально.
5. **Стиль.** Маленькие модули, простые функции, понятные имена. Если функция > 50 строк — подумай, как разбить.
6. **Каталог.** Если меняешь `data/catalog.json` — прогоняй `npx tsx scripts/augment-catalog.ts` чтобы автоматически проставить `image_url` и `tags`.
7. **Миграции БД.** Все изменения схемы — в `db/schema.sql`. Используй `CREATE TABLE IF NOT EXISTS` и `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` для идемпотентности.

## Архитектура

См. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Перед крупной правкой убедись, что понимаешь поток данных и trade-offs.

## Commit message style

Свободный, но желательно префиксом:

- `feat:` — новая функциональность
- `fix:` — баг-фикс
- `refactor:` — без изменения поведения
- `docs:` — только документация
- `test:` — только тесты
- `chore:` — служебные изменения (deps, CI)

Пример: `feat(cart): allow multiple quantities per SKU`

## Pull Requests

1. Веткуйся от `main`.
2. Малые, фокусные PR. Если меняешь больше двух модулей за раз — подумай, как разбить.
3. PR-описание: что и зачем, как тестировал.
4. Дождись зелёного CI.
5. Линк на issue или контекст приветствуется.

## Issues

Шаблоны не используем. Просто опиши:

- что ожидал
- что получил
- шаги воспроизведения
- скриншоты или логи (без секретов)

## Безопасность

Если нашёл уязвимость — пиши в DM авторам, **не открывай публичный issue**.
