# Деплой и эксплуатация

Детальный гайд по запуску и обслуживанию бота. Для краткого старта см. [README.md](../README.md).

## Содержание

1. [Локальный запуск](#локальный-запуск)
2. [Railway (production)](#railway-production)
3. [Переменные окружения](#переменные-окружения)
4. [Здоровье и метрики](#здоровье-и-метрики)
5. [Логирование и мониторинг](#логирование-и-мониторинг)
6. [Эксплуатационные задачи](#эксплуатационные-задачи)
7. [Troubleshooting](#troubleshooting)

## Локальный запуск

```bash
# 1. Зависимости
nvm use            # подхватит .nvmrc (Node 20)
npm ci             # детерминированная установка из package-lock.json

# 2. Инфраструктура (Postgres+Redis в Docker)
docker compose up -d
docker compose ps  # убедись что healthcheck'и зелёные

# 3. Env
cp .env.example .env
# обязательно: TELEGRAM_BOT_TOKEN, GROQ_API_KEY
# опционально: MANAGER_CHAT_ID, ADMIN_USER_ID

# 4. Сборка TS и запуск (миграции и индексация выполнятся автоматически)
npm run build && npm start
# или, без сборки через tsx — быстрый dev-режим:
npm run start:dev
```

После `npm start` HTTP-сервер слушает `localhost:3000`. Проверь:

```bash
curl http://localhost:3000/health   # → {"status":"ok",...}
curl http://localhost:3000/ready    # → {"ready":true,"postgres":true,"redis":true}
curl http://localhost:3000/metrics  # → JSON со счётчиками
```

## Railway (production)

1. **Создай проект** в [Railway](https://railway.app) → `Deploy from GitHub repo` → выбери репо.
2. **Добавь сервисы**:
   - `+ New` → `Database` → `Add PostgreSQL`. Railway раскатает Postgres 16 с pgvector.
   - `+ New` → `Database` → `Add Redis`. Подойдёт любая 6+.
3. **Сконфигурируй переменные** бота (`Variables`):
   - `TELEGRAM_BOT_TOKEN` — от [@BotFather](https://t.me/BotFather).
   - `GROQ_API_KEY` — из [console.groq.com](https://console.groq.com).
   - `MANAGER_CHAT_ID` — твой Telegram user id (или ID группы), куда падают уведомления.
   - `ADMIN_USER_ID` — кому разрешены `/reindex` и `/stats`.
   - `DATABASE_URL` → **Reference** → выбери `Postgres.DATABASE_URL`.
   - `REDIS_URL` → **Reference** → выбери `Redis.REDIS_URL`.

   > ⚠️ Не вставляй URL строкой — при пересоздании БД он протухнет. References — единственный
   > надёжный способ.

4. **Деплой**. Railway соберёт `Dockerfile` (multi-stage: builder компилит TS,
   runtime ставит только prod-deps) и запустит `node dist/src/bootstrap.js`:
   1. `wait-for-db.ts` — ждёт Postgres (до 5 минут).
   2. `schema.sql` — применяет миграции (idempotent через `IF NOT EXISTS`).
   3. `scripts/index-catalog.ts` — пересчитывает embeddings (первый раз качает модель ~120 MB).
   4. `src/bot.ts` — запускает polling (или webhook если `BOT_MODE=webhook`).

5. **Healthcheck**. В настройках сервиса укажи `Healthcheck path: /health` —
   Railway будет автоматически рестартить контейнер при падении.

## Переменные окружения

| Имя                     | Обязательно | Значение по умолчанию          | Описание                                                      |
| ----------------------- | ----------- | ------------------------------ | ------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | да          | —                              | Bot Token из @BotFather                                       |
| `GROQ_API_KEY`          | да          | —                              | API ключ Groq                                                 |
| `DATABASE_URL`          | да          | —                              | строка подключения Postgres (с `sslmode=require` для Railway) |
| `REDIS_URL`             | да          | —                              | строка подключения Redis                                      |
| `MANAGER_CHAT_ID`       | нет         | —                              | куда падают уведомления о заказах                             |
| `ADMIN_USER_ID`         | нет         | —                              | кому разрешены `/reindex`, `/stats`                           |
| `GROQ_MODEL`            | нет         | `llama-3.3-70b-versatile`      | модель Groq                                                   |
| `RATE_LIMIT_PER_MINUTE` | нет         | `20`                           | лимит сообщений на пользователя в минуту                      |
| `EMBEDDING_MODEL`       | нет         | `Xenova/multilingual-e5-small` | модель эмбеддингов (HuggingFace)                              |
| `PORT`                  | нет         | `3000`                         | порт health-сервера                                           |
| `LOG_LEVEL`             | нет         | `info`                         | уровень pino (`debug`/`info`/`warn`/`error`)                  |
| `NODE_ENV`              | нет         | —                              | `production` включает JSON-логи                               |
| `GIT_SHA`               | нет         | —                              | передаётся в `/version` (Railway: `RAILWAY_GIT_COMMIT_SHA`)   |

## Здоровье и метрики

- `GET /health` → 200 пока процесс жив. Использовать для **liveness** в Railway/k8s.
- `GET /ready` → 200 только если Postgres+Redis отвечают. Использовать для **readiness**.
- `GET /metrics` → JSON со счётчиками и latency. Можно скрепить cron'ом или
  отправлять во внешний sink (Datadog/Grafana Cloud).

Пример полезных счётчиков, которые поднимает бот:

```json
{
  "counters": {
    "messages_total": 1234,
    "errors_total": 2,
    "rate_limited_total": 7,
    "llm_calls_total": 1100,
    "fallback_no_match_total": 134,
    "order_status_confirmed": 50,
    "order_status_shipped": 30,
    "order_cancelled_by_client_total": 5
  },
  "latencies": {
    "llm_ms": { "count": 1100, "p50": 720, "p95": 2400, "p99": 4500 },
    "message_ms": { "count": 1234, "p50": 850, "p95": 2700, "p99": 5000 }
  },
  "uptime_seconds": 86400,
  "timestamp": "2026-05-11T22:00:00.000Z"
}
```

## Логирование и мониторинг

Бот использует `pino`. В `NODE_ENV=production` пишет JSON в stdout — Railway автоматически их
индексирует и показывает в Logs.

Ключевые поля каждой записи:

- `level` — `info`/`warn`/`error`/`fatal`.
- `module` — `bot`, `rag`, `logger`, `embeddings`, и т.п. (из `child()`).
- `userId`, `sku`, `err.message` — структурированные поля.

В UI Railway можно фильтровать: `module=bot level=error` найдёт все ошибки в основном пайплайне.

Чувствительные поля (`password`, `token`, `apiKey`, `*.authorization`) автоматически
редактируются ещё на стороне логгера — см. `src/log.ts`.

## Эксплуатационные задачи

| Что нужно                  | Как                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Добавить товары            | редактируй `data/catalog.json`, `git push` → Railway перезапустит и переиндексирует |
| Точечно переиндексировать  | вызови `/reindex` в Telegram под админом                                            |
| Сменить модель LLM         | поменяй `GROQ_MODEL` в Variables Railway → Redeploy                                 |
| Сменить модель эмбеддингов | поменяй `EMBEDDING_MODEL`. **Внимание**: после смены модели нужно `/reindex`.       |
| Снизить расход API         | подними `RATE_LIMIT_PER_MINUTE` ниже и/или попроси LLM-провайдера квоту             |
| Backup БД                  | Railway Postgres → Settings → Backups (или `pg_dump` через `psql $DATABASE_URL`)    |
| Очистить разговоры         | `DELETE FROM conversations WHERE created_at < NOW() - INTERVAL '90 days'`           |

## Troubleshooting

### `getMe провалился`

Токен `TELEGRAM_BOT_TOKEN` неправильный или отозван. Получи новый у `@BotFather`.

### `pgvector: extension "vector" is not available`

Postgres-инстанс без pgvector. На Railway это решено автоматически — образ уже с расширением.
Локально используется `pgvector/pgvector:pg16` (см. `docker-compose.yml`).

### `redis недоступен`

Проверь, что Redis-сервис в Railway зелёный и `REDIS_URL` указан через Reference, а не строкой.

### Бот не отвечает, но `/health` возвращает 200

Скорее всего polling упёрся в Telegram API (другой инстанс держит lock).
Останови все локальные процессы с тем же токеном и/или удали webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TOKEN/deleteWebhook"
```

### Долгий старт (первый деплой)

Первый запуск качает модель эмбеддингов (~120 MB) в `/app/.cache/transformers`.
Это нормально и занимает ~1 минуту. Последующие старты используют кэш.

### LLM выдумывает товары / цены

Проверь:

1. `findProducts` нашёл что-то релевантное (логи: `module=rag`).
2. Системный промпт (`src/prompt.ts`) содержит блок «не выдумывай» — он там есть.
3. Если ответы стабильно мимо — снизь `temperature` в `src/llm.ts` (по умолчанию 0.4).
