# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект следует [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

## [1.8.0] - 2026-05-12

### Added

- **Analytics-дашборд `/analytics` + JSON-снимок `/analytics.json`.** Серверный
  HTML без JS-фреймворков и сети, рендерит:
  - тоталы (всего / 24ч / 7д, уников 24ч, заказы оплачено, fallback-rate),
  - активность по дням за 7 дней,
  - топ-10 запросов (с гистограммой),
  - топ-5 категорий по матчам,
  - топ-10 SKU по матчам,
  - per-variant статистику A/B-фреймворка (средние длины сообщений).
    Endpoints добавлены в OpenAPI-спеку (теги `analytics`), `AnalyticsSnapshot` со
    схемами `AnalyticsTotals`, `DailyBucket`, `TopQuery`, `VariantStats`, `TopCategory`.
- **E2E-симуляция Telegram-клиента (`tests/bot-e2e.test.ts`).** Поднимает
  настоящий Telegraf-инстанс из `src/bot.ts`, монки-патчит `callApi` на
  prototype-уровне, кормит фейковые `Update` через `bot.handleUpdate()`.
  Проверяет /ping, /start, /help, /version, обычное сообщение → LLM,
  fallback без матчей без истории → не вызывает LLM, и инвариант "нет
  пустых sendMessage". Все внешние модули (DB, Redis, RAG, LLM, voice,
  payments, embeddings) замоканы через `vi.mock`.
- 13 новых vitest-тестов: 6 на `analytics` (агрегация, рендер HTML,
  HTML-escape, empty-state, error-resilience) + 7 E2E. Итого 167/167.

### Changed

- Bump 1.7.0 → 1.8.0.

## [1.7.0] - 2026-05-12

### Added

- **OpenAPI 3.1 + Swagger UI на `/docs`.** Новый файл `docs/openapi.yaml`
  документирует все HTTP-эндпоинты (`/health`, `/ready`, `/metrics`,
  `/metrics.json`, `/docs`). На `/docs` рендерится интерактивная Swagger UI
  через статические ассеты из `swagger-ui-dist` — никаких Express и middleware.
  Сама спека доступна по `/docs/openapi.yaml`.
- **A/B-фреймворк системного промпта** (`src/prompt-ab.ts`):
  - Три встроенных варианта: `baseline` (текущий), `sales_focused` (с CTA
    и уточняющими вопросами), `concise` (телеграфный стиль).
  - Детерминированное распределение по `userId` через `sha256 mod N` —
    один и тот же пользователь всегда получает один и тот же variant.
  - Активные варианты задаются через `PROMPT_AB_VARIANTS=baseline,sales_focused`
    (через запятую). Без env активен только `baseline` → нет изменений
    в продакшене по умолчанию.
  - На каждый LLM-ответ инкрементится `prompt_variant_<id>_total` и
    семплится `llm_ms_variant_<id>` → можно сравнить latency и нагрузку
    каждого варианта прямо в Prometheus/Grafana.
  - Каждый запрос в `conversations.prompt_variant` сохраняется — данных
    хватит для оффлайн-анализа (CTR, средняя длина диалога per-variant).
- `registerVariant()` API для регистрации своих вариантов из кода.
- 20 новых vitest-тестов: 14 на `prompt-ab` (распределение, детерминизм,
  filter unknown ids, registerVariant), 6 на `docs.ts` (Swagger UI HTML,
  YAML spec, ассеты, path-traversal protection, fall-through). Итого 154/154.

### Changed

- Bump 1.6.0 → 1.7.0.
- `db/schema.sql`: добавлена идемпотентная миграция
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS prompt_variant TEXT` +
  частичный индекс `WHERE prompt_variant IS NOT NULL`.
- `Dockerfile`: runtime-стадия теперь копирует `docs/openapi.yaml` для
  работы `/docs`.

## [1.6.0] - 2026-05-12

### Added

- **Опциональная телеметрия — Sentry + OpenTelemetry, обе off-by-default.**
  Новый модуль `src/telemetry.ts` лениво (через dynamic import) поднимает
  Sentry SDK при заданном `SENTRY_DSN` и/или standalone OpenTelemetry NodeSDK
  с OTLP/HTTP экспортёром при `OTEL_EXPORTER_OTLP_ENDPOINT`. Без env-переменных
  модули даже не загружаются в память — нулевой оверхед в проде.
- Sentry-инстанс используется через `captureException()` в catch-блоках
  `handleUserMessage` и voice-транскрипции — ошибки летят в Sentry с контекстом
  (`userId`, `scope`), но никогда не валят приложение.
- `/health` теперь возвращает `telemetry: { sentry, otel }` snapshot —
  удобно проверить из CI/мониторинга, поднялась ли телеметрия.
- Graceful shutdown: `SIGINT`/`SIGTERM` дозванивают `Sentry.close()` и
  `NodeSDK.shutdown()` с тайм-аутом 2 с, чтобы события не терялись.
- 13 новых vitest-тестов: no-op без env, активация по SENTRY_DSN, активация
  по OTEL endpoint, взаимное исключение Sentry vs OTel, устойчивость к падениям
  init/capture/shutdown. Итого 134/134 теста.

### Changed

- Защита от двойного OTel-инстанса: если `SENTRY_DSN` задан, standalone NodeSDK
  пропускается (Sentry сам поднимает OTel внутри), о чём пишется в лог.

## [1.5.0] - 2026-05-12

### Added

- **TypeScript migration со strict-mode.** Весь runtime-код, тесты и скрипты
  (46 файлов) переведены с `.js` на `.ts`. `tsconfig.json` со `strict: true`,
  `noUnusedLocals`, `noUnusedParameters`, `forceConsistentCasingInFileNames`.
  Отдельный `tsconfig.build.json` для прод-сборки (без `tests/`). Multi-stage
  `Dockerfile`: builder компилит TS, runtime ставит только prod deps.
- `src/types.ts` — централизованные domain-типы (`Product`, `Order`, `OrderStatus`).
- CI шаг `typecheck` (tsc --noEmit) в matrix Node 20+22.
- Скрипты `start:dev` (tsx) и `build` (tsc -p tsconfig.build.json) в package.json.

### Changed

- ESLint v9 flat-config расширен `typescript-eslint` рекомендациями.
- Procfile, Dockerfile, railway.json теперь указывают на `dist/src/bootstrap.js`.

### Fixed

- **Регрессия деплоя (#19).** После TS-сборки бот падал с `ENOENT:
/app/dist/db/schema.sql`, потому что (а) Dockerfile не копировал `db/` и
  `data/` в runtime-стадию, (б) пути собирались относительно `__dirname`,
  что после `tsc` резолвилось в `dist/db/schema.sql` вместо `db/schema.sql`.
  Введён `src/paths.ts` с `resolveRepoFile()` — robust поиск файлов от любой
  стартовой точки (`src/` или `dist/src/`). Dockerfile явно копирует
  `db/` и `data/` в runtime. 4 unit-теста для `paths.ts` чтобы регрессия
  не вернулась.

## [1.4.0] - 2026-05-12

### Added

- **Telegram Payments** — корзина превращается в встроенный чекаут Telegram.
  Бот отправляет `sendInvoice` с правильным `payload` (мапа на order_id),
  отвечает на `pre_checkout_query` после валидации (статус заказа +
  принадлежность пользователю), и помечает заказы как `paid` с записью
  `payment_charge_id`/`payment_amount` в БД при `successful_payment`.
  Менеджер получает уведомление об оплате. Полностью опционально:
  без `PAYMENT_PROVIDER_TOKEN` остаётся ручной checkout.
- Новые статусы заказа `pending_payment` и `paid` в `VALID_STATUSES`.
- Колонки `paid_at`, `payment_provider`, `payment_charge_id`, `payment_amount`,
  `payment_currency` в таблице `orders` (idempotent migration).
- Метрики `invoice_sent_total`, `invoice_send_failed_total`,
  `pre_checkout_approved_total`, `pre_checkout_rejected_total`,
  `pre_checkout_error_total`, `payment_success_total`, `payment_error_total`.
- Тесты `tests/payments.test.ts` (22 кейса: payload, валидация, флоу).

### Changed

- `recordOrder({status})` принимает initial status — `pending_payment` для
  payments-флоу, `new` для ручного checkout.

## [1.3.0] - 2026-05-12

### Added

- **Voice messages** — бот принимает голосовые сообщения Telegram, транскрибирует через
  Groq Whisper (`whisper-large-v3-turbo` по умолчанию) и пропускает результат через тот же
  RAG-флоу. Лимиты по длительности (60с) и размеру (20MB) настраиваются через
  `MAX_VOICE_SECONDS` / `MAX_VOICE_BYTES`. Метрики `voice_transcribed_total`,
  `voice_too_long_total`, `voice_error_total`, `whisper_ms` (p50/p95/p99).
- Тесты `tests/voice.test.ts` (8 кейсов: успех, лимиты, ошибки download, пустой результат).

## [1.2.0] - 2026-05-12

### Added

- **Embedding cache** — векторы `embedQuery`/`embedPassage` кэшируются в Redis с TTL 7 дней
  (настраивается через `EMBEDDING_CACHE_TTL_SECONDS`). Hit/miss считаются в метриках
  (`embedding_cache_hit_total`, `embedding_cache_miss_total`). Сжимает p95 latency RAG-пайплайна.
- **Prometheus exporter** — `/metrics` теперь отдаёт стандартный Prometheus text-формат
  (counters + summary с квантилями 0.5/0.95/0.99). JSON snapshot перенесён на `/metrics.json`.
  Прямо подключается к Grafana Agent / VictoriaMetrics / Prometheus.
- **Webhook mode** — переменная `BOT_MODE=webhook` запускает бота через Telegram webhook
  вместо polling'а. Поддерживается через единый HTTP-сервер (вместе с health/metrics),
  опциональный `WEBHOOK_SECRET_TOKEN` для проверки `X-Telegram-Bot-Api-Secret-Token`.
- Тесты `tests/prom.test.ts` (6 кейсов) и `tests/embedding-cache.test.ts` (8 кейсов).
- Метод `keys(pattern)` и поддержка array-аргумента у `del()` в `redis-mock`.

### Changed

- `src/bot.ts`: автозапуск теперь под флагом `BOT_NO_AUTOSTART` — bootstrap сам решает режим.
- `src/embeddings.ts`: путь `embed()` сначала спрашивает кэш, мисс пишет вектор обратно
  не блокируя ответ.

## [1.1.0] - 2026-05-11

### Added

- ESLint v9 (flat-config) и Prettier — заменили примитивный `node --check`.
- Husky + lint-staged — pre-commit хуки на форматирование и линт staged-файлов.
- `.editorconfig` и `.nvmrc` для единого стиля и фиксированной версии Node.
- CI matrix: тесты на Node 20 и Node 22, прогон с coverage, артефакт с покрытием.
- `concurrency.cancel-in-progress` — отмена устаревших CI-ранов.
- Workflow `codeql.yml` — security scanning от GitHub.
- `dependabot.yml` — еженедельные апдейты npm/actions/docker.
- `SECURITY.md`, `CODEOWNERS`, PR template, issue templates (bug/feature).
- Команда `/version` — показывает версию бота, git SHA и Node.js.
- Команда `/cancel` — клиент может сам отменить свой последний активный заказ.
- `setMyCommands` — команды показываются в меню Telegram при старте.
- Endpoint'ы `/health`, `/ready`, `/metrics` в bootstrap-сервере.
- In-process метрики: `messages_total`, `errors_total`, `llm_ms` p50/p95/p99, и др.
- Тесты для `cart`, `carousel`, `session`, `access`, `order-status`, `metrics`,
  `ui.escapeMd`, `ui.truncate`. Покрытие тестов выросло.

### Changed

- Единый Redis-клиент в `src/redis.ts`. До этого `session.ts`, `cart.ts`,
  `carousel.ts` поднимали по своему отдельному коннекту.
- Cart `addToCart` теперь реально enforce-ит `MAX_ITEMS=20` и возвращает
  `{ added, size, limit }`. Раньше лимит экспортировался, но не проверялся.
- Бот не показывает клиенту `err.message` при ошибках — только дружественный fallback.
- Длина пользовательского сообщения обрезается до 1000 символов перед LLM.
- `STATUS_LABELS` и валидация статусов вынесены в `src/order-status.ts`,
  `isAdmin`/`isManager` — в `src/access.ts`. Чище модули и легче тестить.
- `npm start` теперь запускает `src/bootstrap.ts` (а не `src/bot.ts`) — единый
  путь и для локалки и для Railway: миграции + индексация + бот.

### Fixed

- Удалён dead-code `sendProductCard` в `src/bot.ts`.
- `handlerTimeout: 60_000` в Telegraf — длинные LLM-ответы не валят обработчики.

## [1.0.0] - 2025-12

### Added

- Первый публичный релиз. RAG (pgvector + e5-small) + Telegraf + Groq LLM,
  корзина и заказы в Redis/Postgres, статус-уведомления менеджеру.
