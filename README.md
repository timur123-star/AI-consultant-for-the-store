# AI-консультант для онлайн-магазина — Telegram-бот

Полноценный продакшен-grade Telegram-бот для розничного магазина: понимает естественный язык, подбирает товары по каталогу через **RAG**, помнит контекст диалога, ведёт корзину, обрабатывает заказы и уведомляет менеджера. Portfolio piece.

`Node 20` · `Telegraf 4` · `Groq (Llama 3.3 70B)` · `pgvector` · `Redis` · `@huggingface/transformers`

[![CI](https://github.com/timur123-star/AI-consultant-for-the-store/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/timur123-star/AI-consultant-for-the-store/actions/workflows/ci.yml)
[![CodeQL](https://github.com/timur123-star/AI-consultant-for-the-store/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/timur123-star/AI-consultant-for-the-store/actions/workflows/codeql.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Telegraf](https://img.shields.io/badge/Telegraf-4-26A5E4?logo=telegram&logoColor=white)](https://telegraf.js.org/)
[![Postgres](https://img.shields.io/badge/Postgres-16%20%2B%20pgvector-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![Vitest](https://img.shields.io/badge/tests-vitest%20%C2%B7%20167-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5%20%C2%B7%20strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[Source](https://github.com/timur123-star/AI-consultant-for-the-store) · [Architecture](./docs/ARCHITECTURE.md) · [Deployment](./docs/DEPLOYMENT.md) · [Changelog](./CHANGELOG.md)

![Каталог демо-магазина](https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=1600&q=80&auto=format&fit=crop)

---

## About this project

«КожаМастер» — портфолио-проект: Telegram-консультант для вымышленного магазина кожаных
изделий. 76 SKU в 8 категориях, реальные RAG-запросы через pgvector, настоящие LLM-ответы
через Groq, и весь production-обвес — от health-эндпоинтов до CI matrix и CodeQL —
сделаны как для боевого сервиса, а не «MVP в выходные».

Каждый модуль, тест, миграция и блок документации написан вручную: ни CMS, ни no-code
конструкторов, ни шаблонных туториалов «из коробки».

> **Disclaimer.** Магазин «КожаМастер», SKU, цены, отзывы и описания товаров — fictional, написаны исключительно для портфолио. Фотографии товаров — случайные снимки из публичного CDN [Unsplash](https://unsplash.com), детерминированно подобранные по категории. Архитектура и код переносятся на любой розничный магазин без правок.
>
> Designed and built by **Тимур Валерьевич**.

> **Companion-проекты.** Этот бот — backend-часть моего портфолио. Frontend-вселенная живёт здесь:
>
> - **NOVA Agency** — маркетинговый сайт студии (Next.js 14 + Tailwind + Framer Motion) →
>   [landing-page-for-an-agency-production.up.railway.app](https://landing-page-for-an-agency-production.up.railway.app/) ·
>   [source](https://github.com/timur123-star/Landing-page-for-an-agency)
> - **Lumen Analytics** — login-gated multilingual SaaS-дашборд с Groq AI-ассистентом →
>   [lumen-analytics-new.up.railway.app](https://lumen-analytics-new.up.railway.app/) ·
>   [source](https://github.com/timur123-star/Lumen-Analytics)

---

## Что внутри

### Поведение бота

- **Свободный текст**. «Нужна сумка из кожи до 8к», «что-то тёплое на зиму», «подарок мужу
  на 23 февраля» — бот понимает запрос, ищет по embedding'ам и предлагает реальные SKU.
- **Карусель в одном сообщении**. Поиск/каталог/популярное листаются стрелками
  ◀ N/M ▶ через `editMessageMedia`, без спама в чате.
- **Корзина на Redis** с TTL 24 ч: добавил → продолжил выбор → оформил.
- **Заказы со статусами**: `new → confirmed → shipped → delivered/cancelled`, клиент
  автоматически уведомляется о смене.
- **Кнопки для менеджера**: ✅ Подтвердить · 📦 Отправлен · ❌ Отменить — прямо в чате,
  без админ-панели.
- **`/featured` и smart fallback**: если поиск пуст — показываем популярное за 30 дней.
- **`/catalog`** из кнопок → клик по категории → карусель этой категории.
- **`/cancel`** — клиент сам отменяет свой активный заказ.
- **`/version`** — версия бота, commit SHA, версия Node — удобно для разбора инцидентов.
- **Память диалога** — последние 10 пар сообщений хранятся в Redis на 24 ч.
- **Rate-limit** 20 сообщений/мин на пользователя, friendly fallback при превышении.

### Что под капотом

- **RAG-пайплайн**. Запрос → embedding (`multilingual-e5-small`, локально, без API-ключа) →
  pgvector cosine top-K → передача в Groq Llama-3.3-70B с system-промптом «не выдумывай,
  только из контекста» → ответ. Защита от LLM-галлюцинаций встроена в промпт.
- **Pgvector + IVFFlat**. Caталог индексируется один раз при старте; повторные апдейты
  идемпотентны. Cosine-distance для top-K, `lists = 100` для IVFFlat.
- **Единый shared Redis-client** ([`src/redis.ts`](src/redis.ts)) — session, cart, carousel
  ходят в один пул с lazy-connect и graceful shutdown.
- **In-process метрики** — счётчики, p50/p95/p99 latency без внешних зависимостей.
- **Structured logs** (`pino`, JSON в prod) — каждое сообщение тегировано модулем,
  чувствительные поля (`token`, `apiKey`, `authorization`) редактируются автоматически.

### Качество и инфраструктура

- **ESLint v9 flat-config** + **Prettier 3** + **husky + lint-staged**: pre-commit
  прогоняет линт/формат только по staged-файлам.
- **CI matrix Node 20 + 22** с coverage и `concurrency: cancel-in-progress`.
- **CodeQL** security scanning на каждый push и pull request.
- **Dependabot** — еженедельные апдейты npm / actions / docker.
- **TypeScript 5 со strict-mode** — весь runtime, тесты и скрипты на TS, прод-сборка
  через `tsc -p tsconfig.build.json`, dev через `tsx`. CI включает `tsc --noEmit`
  на Node 20 и Node 22.
- **167 vitest тестов** (22 файла) для cart, carousel, session, access, order-status,
  metrics, rag, ui, prom-exporter, embedding-cache, voice, payments, paths, telemetry,
  prompt-ab, docs, analytics + E2E-симуляция Telegram-клиента (монки-патч
  `Telegraf.callApi` + `bot.handleUpdate()`) — с in-memory Redis mock.
- **`/analytics` дашборд + `/analytics.json` JSON-снимок.** Серверный HTML
  без JS-фреймворков и сети: тоталы 24ч/7д, активность по дням, топ-10
  запросов, топ категорий и SKU, per-variant статистика A/B-фреймворка.
  Dark-mode через `prefers-color-scheme`. JSON-снимок подходит для Grafana/Metabase.
- **OpenAPI 3.1 спека + Swagger UI на `/docs`.** Интерактивная документация к
  операционным эндпоинтам (`/health`, `/ready`, `/metrics`, `/metrics.json`). Спека
  также доступна в raw-виде по `/docs/openapi.yaml`.
- **A/B-фреймворк системного промпта.** Три встроенных варианта (`baseline`,
  `sales_focused`, `concise`), детерминированное распределение по `userId` (sha256 mod N),
  per-variant counter `prompt_variant_<id>_total` и latency-семпл `llm_ms_variant_<id>`,
  хранение `prompt_variant` в `conversations` для оффлайн-анализа. Активируется
  через `PROMPT_AB_VARIANTS=baseline,sales_focused`.
- **Опциональная телеметрия — Sentry + OpenTelemetry, off-by-default.** При пустых
  `SENTRY_DSN` и `OTEL_EXPORTER_OTLP_ENDPOINT` модули даже не загружаются в память — нулевой
  оверхед. При включении ошибки из catch-блоков летят в Sentry с контекстом
  (`userId`, scope), трейсы распространяются через OTLP/HTTP экспортёр. Graceful
  shutdown дозванивает оба SDK с тайм-аутом 2 с.
- **Observability**: HTTP-сервер обслуживает `/health` (liveness), `/ready` (проверка Postgres + Redis),
  **`/metrics` в Prometheus text-формате** (counters + summary с квантилями 0.5/0.95/0.99) —
  готов к скрейпу Grafana / Prometheus, и `/metrics.json` для людей.
- **Embedding cache** в Redis (TTL 7 дней): одинаковые запросы не перевычисляют embedding,
  сжимая p95 latency RAG-пайплайна. Hit/miss считаются как `embedding_cache_hit_total` /
  `embedding_cache_miss_total`.
- **Два режима работы** — polling (дефолт) или webhook (`BOT_MODE=webhook`). Webhook подключается к
  тому же HTTP-серверу, поддерживает `WEBHOOK_SECRET_TOKEN`.
- **Голосовые сообщения** — клиент жмёт mic, говорит, Groq Whisper (`whisper-large-v3-turbo`)
  транскрибирует, бот отвечает через тот же RAG-флоу. Лимиты по длительности (60с)
  и размеру (20MB) настраиваются. Метрики `whisper_ms` p50/p95/p99 + счётчики ошибок.
- **Telegram Payments** — корзина превращается в встроенный чекаут (`sendInvoice`),
  бот валидирует `pre_checkout_query` (статус заказа + принадлежность юзеру) и
  помечает заказы `paid` с записью `charge_id`/`amount` на `successful_payment`.
  Опционально: без `PAYMENT_PROVIDER_TOKEN` остаётся ручной checkout.
- **Документация**: `README.md`, `docs/ARCHITECTURE.md` (схема БД, design decisions,
  scaling), `docs/DEPLOYMENT.md` (Railway, env, troubleshooting), `CHANGELOG.md`
  (Keep a Changelog), `SECURITY.md` (disclosure policy), `CONTRIBUTING.md`.

---

## Архитектура

```
                        ┌───────────────────────────┐
                        │  Telegram (BotFather API) │
                        └────────────┬──────────────┘
                                     │ polling (long-poll)
                                     ▼
       ┌─────────────────────────────────────────────────────┐
       │                  src/bot.ts (Telegraf 4)            │
       │  commands · callbacks · rate-limit · access-control │
       └──────────┬─────────────────────────────┬────────────┘
                  │                             │
                  ▼                             ▼
     ┌──────────────────────┐         ┌───────────────────────┐
     │  src/rag.ts  + RAG   │         │   src/session.ts      │
     │  embeddings·top-K    │         │   cart · carousel     │
     └──────┬───────────────┘         │   history·rate-limit  │
            │                         └──────────┬────────────┘
            ▼                                    │
   ┌────────────────────┐                        ▼
   │ Postgres 16        │              ┌──────────────────────┐
   │   + pgvector       │              │  Redis 7 (shared)    │
   │   IVFFlat cosine   │              │  src/redis.ts client │
   └────────────────────┘              └──────────────────────┘
            │
            ▼
   ┌────────────────────┐         ┌──────────────────────────┐
   │  Groq Llama-3.3-70B│         │  HTTP server (PORT)      │
   │  temperature 0.4   │         │  /health /ready /metrics │
   └────────────────────┘         └──────────────────────────┘
```

Подробная схема БД, design decisions и scaling — в [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Стек

| Слой          | Технология                                                                                              | Зачем именно она                                             |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Bot framework | [Telegraf 4](https://telegraf.js.org)                                                                   | стабильный, middlewares, типизированный                      |
| LLM           | [Groq](https://groq.com) (`llama-3.3-70b-versatile`)                                                    | бесплатный tier, очень быстрый, OpenAI-совместимый API       |
| Embeddings    | [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) + `multilingual-e5-small` | локально, без API-ключа, понимает русский                    |
| Vector DB     | [PostgreSQL 16](https://www.postgresql.org/) + [pgvector](https://github.com/pgvector/pgvector)         | один сервис — и хранение, и поиск, IVFFlat-индекс            |
| Cache / state | [Redis 7](https://redis.io)                                                                             | история чата + rate-limit + корзина + carousel tokens        |
| Logs          | [pino](https://getpino.io)                                                                              | structured JSON в prod, pino-pretty локально                 |
| Lint / format | [ESLint v9](https://eslint.org) + [Prettier 3](https://prettier.io)                                     | flat-config, husky + lint-staged на pre-commit               |
| Tests         | [Vitest 4](https://vitest.dev)                                                                          | 73 unit-теста, coverage v8, CI matrix Node 20+22             |
| Security      | [CodeQL](https://codeql.github.com) + [Dependabot](https://docs.github.com/en/code-security/dependabot) | weekly scanning + dep updates                                |
| Hosting       | [Railway](https://railway.com)                                                                          | Dockerfile + reference variables + Postgres+Redis из коробки |

---

## Getting started

```bash
nvm use                 # подхватит .nvmrc (Node 20)
npm ci                  # детерминированная установка + husky хуки

docker compose up -d    # Postgres 16 + pgvector + Redis 7

cp .env.example .env    # заполни TELEGRAM_BOT_TOKEN, GROQ_API_KEY, …

npm start               # миграции → индексация → бот
```

После `npm start` HTTP-сервер слушает `:3000`:

```bash
curl http://localhost:3000/health         # { "status": "ok", "uptime_seconds": 42 }
curl http://localhost:3000/ready          # { "ready": true, "postgres": true, "redis": true }
curl http://localhost:3000/metrics        # Prometheus text exposition format
curl http://localhost:3000/metrics.json   # JSON snapshot (counters + p50/p95/p99)
```

### Scripts

```bash
npm start                # bootstrap (миграции + индексация + бот)
npm run migrate          # только миграции
npm run reindex          # только индексация каталога
npm test                 # vitest run
npm run test:watch       # watch-режим
npm run coverage         # vitest run --coverage (~77% statements)
npm run lint             # ESLint v9 (flat-config)
npm run lint:fix         # ESLint --fix
npm run format           # Prettier --write .
npm run format:check     # Prettier --check . (используется в CI)
```

### Environment variables

| Имя                           | Обязательно | По умолчанию                   | Описание                                                      |
| ----------------------------- | ----------- | ------------------------------ | ------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`          | да          | —                              | от [@BotFather](https://t.me/BotFather)                       |
| `GROQ_API_KEY`                | да          | —                              | [console.groq.com](https://console.groq.com)                  |
| `DATABASE_URL`                | да          | —                              | строка подключения Postgres (с `sslmode=require` для Railway) |
| `REDIS_URL`                   | да          | —                              | строка подключения Redis                                      |
| `MANAGER_CHAT_ID`             | нет         | —                              | куда падают уведомления о новых заказах                       |
| `ADMIN_USER_ID`               | нет         | —                              | кому разрешены `/reindex`, `/stats`                           |
| `GROQ_MODEL`                  | нет         | `llama-3.3-70b-versatile`      | модель Groq                                                   |
| `RATE_LIMIT_PER_MINUTE`       | нет         | `20`                           | лимит сообщений на пользователя в минуту                      |
| `EMBEDDING_MODEL`             | нет         | `Xenova/multilingual-e5-small` | HF-модель для эмбеддингов                                     |
| `EMBEDDING_CACHE_TTL_SECONDS` | нет         | `604800`                       | TTL кэша эмбеддингов в Redis (дефолт 7 дней)                  |
| `BOT_MODE`                    | нет         | `polling`                      | `polling` (дефолт) или `webhook`                              |
| `WEBHOOK_DOMAIN`              | webhook     | —                              | HTTPS-домен, куда Telegram пушит апдейты                      |
| `WEBHOOK_PATH`                | нет         | `/telegram/webhook`            | путь webhook на HTTP-сервере                                  |
| `WEBHOOK_SECRET_TOKEN`        | нет         | —                              | секрет в X-Telegram-Bot-Api-Secret-Token                      |
| `WHISPER_MODEL`               | нет         | `whisper-large-v3-turbo`       | модель Groq для транскрипции голосовых                        |
| `MAX_VOICE_SECONDS`           | нет         | `60`                           | макс. длительность голосового, сек                            |
| `MAX_VOICE_BYTES`             | нет         | `20971520`                     | макс. размер файла голосового (20 MB)                         |
| `PAYMENT_PROVIDER_TOKEN`      | нет         | —                              | токен платёжного провайдера от @BotFather (Stripe/ЮKassa/...) |
| `PAYMENT_CURRENCY`            | нет         | `RUB`                          | валюта инвойса (ISO 4217)                                     |
| `PORT`                        | нет         | `3000`                         | порт health-сервера                                           |
| `LOG_LEVEL`                   | нет         | `info`                         | уровень pino                                                  |
| `NODE_ENV`                    | нет         | —                              | `production` включает JSON-логи                               |

Полный гайд по деплою и troubleshooting — в [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

---

## Команды бота

| Команда           | Кто      | Что делает                                     |
| ----------------- | -------- | ---------------------------------------------- |
| `/start`          | все      | приветствие + reply-клавиатура + deep-link     |
| `/help`           | все      | подсказки                                      |
| `/clear`          | все      | стереть память диалога                         |
| `/catalog`        | все      | категории с количеством товаров                |
| `/featured`       | все      | топ-6 популярных позиций                       |
| `/cart`           | все      | моя корзина с кнопками управления              |
| `/cancel`         | все      | отменить свой последний активный заказ         |
| `/version`        | все      | версия бота, commit SHA, версия Node           |
| `/search <query>` | менеджер | поиск по SKU/имени/категории                   |
| `/orders`         | менеджер | последние 10 заказов со статусами              |
| `/stats`          | admin    | диалоги, пользователи, заказы, топ-5 за неделю |
| `/reindex`        | admin    | пересчитать embeddings из `data/catalog.json`  |

Команды автоматически регистрируются через `setMyCommands` — появляются в меню Telegram.

---

## Project layout

```
src/
├── bot.ts              # Telegraf entrypoint: commands, callbacks, error handler
├── bootstrap.ts        # railway-вход: HTTP-сервер /health /ready /metrics → bot
├── rag.ts              # поиск по pgvector + сборка контекста для LLM
├── llm.ts              # тонкая обёртка над Groq SDK
├── embeddings.ts       # @huggingface/transformers + кэш модели
├── embedding-cache.ts  # Redis-кэш векторов с TTL
├── prompt.ts           # system prompt, store info, fewshots
├── redis.ts            # ⭐ единый shared Redis client + ping/close
├── session.ts          # история диалога + rate-limit
├── cart.ts             # корзина с MAX_ITEMS=20 enforce
├── carousel.ts         # карусель в одном сообщении (editMessageMedia)
├── access.ts           # isAdmin / isManager
├── order-status.ts     # статусы + локализованные сообщения
├── metrics.ts          # in-process counters + p50/p95/p99
├── prom.ts             # Prometheus text-экспортёр метрик
├── log.ts              # pino + redact + child loggers
├── logger.ts           # высокоуровневые helpers логирования
├── db.ts               # pg pool + миграции + helpers
├── paths.ts            # robust поиск репо-файлов после tsc-build
├── ui.ts               # форматирование Markdown, кнопки, escape
├── config.ts           # env → typed config object
├── voice.ts            # Groq Whisper транскрипция голосовых
├── payments.ts         # Telegram Payments: invoice, pre-checkout, success
├── types.ts            # domain-типы (Product, Order, OrderStatus)
└── wait-for-db.ts      # ожидание Postgres при старте

tests/                  # 121 vitest-тест с in-memory Redis mock
data/catalog.json       # 76 SKU в 8 категориях (демо-каталог)
db/schema.sql           # idempotent миграции (vector + IVFFlat)
docs/                   # ARCHITECTURE.md, DEPLOYMENT.md
.github/                # CI matrix, CodeQL, Dependabot, PR/issue templates
```

---

## Quality bar

- `npm run lint` — clean, ноль warnings (ESLint v9 flat-config + typescript-eslint).
- `npm run format:check` — Prettier 3, 100% соответствие.
- `npm run typecheck` — `tsc --noEmit` со strict-mode, ноль ошибок.
- `npm test` — 121/121 зелёных (vitest, 17 файлов).
- `npm run coverage` — 77%+ statements на `src/**/*.ts` (исключены
  интеграционные точки `bot.ts` / `bootstrap.ts` / `wait-for-db.ts`).
- **GitHub Actions** прогоняет lint + format-check + typecheck + tests + coverage на **Node 20 и
  Node 22** на каждом push/PR. CodeQL делает security-scanning по расписанию + на PR.
- Pre-commit hook (husky + lint-staged) гонит ESLint и Prettier только по staged-файлам —
  CI на стороне сервера ловит остальное.
- Чувствительные поля (`token`, `apiKey`, `password`, `authorization`) автоматически
  редактируются в логах (`src/log.ts`).
- `err.message` никогда не утекает клиенту — только дружественный fallback.

---

## Скриншоты

> Telegram-чат, демо-каталог «КожаМастер». Фотографии товаров детерминированно подбираются
> из публичного [Unsplash](https://unsplash.com) CDN по категории — нет ни одного «реального»
> SKU, всё — для портфолио.

<table>
<tr>
<td width="33%">

![Сумки](https://images.unsplash.com/photo-1591561954557-26941169b49e?w=600&q=80&auto=format&fit=crop)

**Сумки** — 9 SKU

</td>
<td width="33%">

![Кошельки](https://images.unsplash.com/photo-1627123424574-724758594e93?w=600&q=80&auto=format&fit=crop)

**Кошельки** — от 3 500 ₽

</td>
<td width="33%">

![Ремни](https://images.unsplash.com/photo-1624222247344-550fb60583dc?w=600&q=80&auto=format&fit=crop)

**Ремни** — вручная прошивка

</td>
</tr>
<tr>
<td>

![Перчатки](https://images.unsplash.com/photo-1610824352934-c10d87b700cc?w=600&q=80&auto=format&fit=crop)

**Перчатки** — на овчине

</td>
<td>

![Путешествия](https://images.unsplash.com/photo-1565538810643-b5bdb714032a?w=600&q=80&auto=format&fit=crop)

**Путешествия** — несессеры и паспорт

</td>
<td>

![Подарочные наборы](https://images.unsplash.com/photo-1513885535751-8b9238bd345a?w=600&q=80&auto=format&fit=crop)

**Подарочные наборы**

</td>
</tr>
</table>

---

## Расширение под другой магазин

1. Замени `data/catalog.json` своими SKU. Формат: `sku`, `name`, `category`, `price`,
   `description`. Опционально — `image_url`, `tags`.
2. Прогон `npx tsx scripts/augment-catalog.ts` проставит автоматически `image_url`
   (Unsplash placeholder) и `tags` (эвристика по описанию).
3. Отредактируй `STORE_INFO` и тексты в [`src/prompt.ts`](src/prompt.ts): доставка, оплата,
   контакты, гарантия.
4. Запусти `npm run reindex` локально или `/reindex` в Telegram (под админом).

Никаких изменений в коде ядра не требуется — каталог и тексты полностью разделены.

---

## Документация

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — архитектура, схема БД, design decisions, scaling
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — детальный гайд по Railway, env-переменным, troubleshooting
- [`CHANGELOG.md`](./CHANGELOG.md) — история версий (Keep a Changelog)
- [`SECURITY.md`](./SECURITY.md) — куда репортить уязвимости
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — стандарты кода и порядок PR
- [`LICENSE`](./LICENSE) — MIT

---

## Author

Designed and built by **Тимур Валерьевич** as part of a multi-repo portfolio:

- 🎨 **NOVA Agency** — Next.js 14 + Tailwind + Framer Motion landing →
  [demo](https://landing-page-for-an-agency-production.up.railway.app/) ·
  [source](https://github.com/timur123-star/Landing-page-for-an-agency)
- 📊 **Lumen Analytics** — multilingual SaaS dashboard с Groq AI →
  [demo](https://lumen-analytics-new.up.railway.app/) ·
  [source](https://github.com/timur123-star/Lumen-Analytics)
- 🤖 **AI-consultant** (this repo) — Telegram-бот для розничного магазина.

## License

MIT — see [`LICENSE`](./LICENSE).
