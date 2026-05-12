# Multi-stage build: компилируем TS в dist/ на отдельной стадии, в финальный
# образ кладём только продакшн-зависимости + скомпилированный JS.
FROM node:26-slim AS builder

WORKDIR /app

# Зависимости отдельным слоем — для эффективного кеша.
COPY package.json package-lock.json* ./
RUN npm ci

# Копируем исходники и конфиги TS, собираем dist/.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- Runtime stage ----
FROM node:26-slim

WORKDIR /app

# Ставим только runtime-зависимости — никаких typescript/tsx в финальном образе.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Копируем скомпилированный код из builder.
COPY --from=builder /app/dist ./dist

# Runtime-данные (схема БД, каталог товаров) нужны процессу — лежат вне dist/.
# Пути резолвятся через src/paths.ts: поиск 'db/schema.sql' и 'data/catalog.json'
# поднимается по родительским директориям от dist/src/ до /app, где есть и то и другое.
COPY db ./db
COPY data ./data
# OpenAPI спека для /docs (Swagger UI читает её по `/docs/openapi.yaml`).
COPY docs/openapi.yaml ./docs/openapi.yaml

# Каталог для скачанной модели Xenova — Transformers.js кеширует туда.
ENV TRANSFORMERS_CACHE=/app/.cache/transformers
ENV NODE_ENV=production

# Railway сам прокидывает PORT, но боту в polling-режиме порт не нужен —
# объявляем его на случай перехода на webhook.
EXPOSE 3000

CMD ["node", "dist/src/bootstrap.js"]
