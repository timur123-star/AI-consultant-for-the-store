-- Включаем расширение для векторного поиска
CREATE EXTENSION IF NOT EXISTS vector;

-- Каталог товаров.
-- embedding(384) соответствует размерности Xenova/multilingual-e5-small.
CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    sku           TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL,
    price         INTEGER NOT NULL,
    category      TEXT NOT NULL,
    in_stock      BOOLEAN NOT NULL DEFAULT TRUE,
    image_url     TEXT,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    embedding     vector(384),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Идемпотентные миграции — для уже существующих баз без этих полей.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- IVFFlat индекс для быстрого приближённого поиска.
-- Для каталога < 1000 SKU достаточно sequential scan, но индекс делает решение
-- масштабируемым до сотен тысяч позиций.
CREATE INDEX IF NOT EXISTS products_embedding_idx
    ON products
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);

-- Журнал диалогов: владелец магазина может анализировать частые запросы,
-- находить пробелы в каталоге и улучшать описания товаров.
CREATE TABLE IF NOT EXISTS conversations (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL,
    username     TEXT,
    user_text    TEXT NOT NULL,
    bot_text     TEXT NOT NULL,
    matched_skus TEXT[],
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Идентификатор A/B-варианта system-prompt'а, выбранного при ответе.
-- Nullable для исторических записей до запуска A/B-фреймворка.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS prompt_variant TEXT;

CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations(user_id);
CREATE INDEX IF NOT EXISTS conversations_created_at_idx ON conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_prompt_variant_idx
    ON conversations(prompt_variant)
    WHERE prompt_variant IS NOT NULL;

-- Заказы. Одна строка = одна позиция.
-- status проходит линейку: new → confirmed → shipped → delivered (или cancelled).
CREATE TABLE IF NOT EXISTS orders (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL,
    username     TEXT,
    product_id   INTEGER NOT NULL REFERENCES products(id),
    status       TEXT NOT NULL DEFAULT 'new',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Поля для Telegram Payments (см. src/payments.js).
-- Все nullable: ручной checkout без оплаты их не использует.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_charge_id TEXT;
-- payment_amount хранится в minor units (копейки/центы) — как Telegram отдаёт.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_amount INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_currency TEXT;

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_paid_at_idx ON orders(paid_at) WHERE paid_at IS NOT NULL;
