// Доменные типы: товары, заказы, диалоги — выделены в один файл, чтобы
// одно определение разделяли все модули (RAG, бот, логгер, payments).

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  price: number;
  category: string;
  in_stock: boolean;
  image_url: string | null;
  tags?: string[];
}

// Товар с дополнительным полем cosine distance из pgvector-поиска.
export interface ProductWithDistance extends Product {
  distance: number;
}

// Запись в таблице orders.
export interface Order {
  id: number;
  user_id: number;
  username: string | null;
  product_id: number;
  status: string;
  created_at: string;
  updated_at?: string;
  paid_at?: string | null;
  payment_provider?: string | null;
  payment_charge_id?: string | null;
  payment_amount?: number | null;
  payment_currency?: string | null;
}

// Денормализованная запись для /orders менеджера (заказ + товар).
export interface OrderWithProduct extends Order {
  product_name: string;
  sku: string;
  price: number;
}

// Категория для каталога — пара «название → счётчик».
export interface CategoryCount {
  category: string;
  cnt: number;
}

// Сообщение в истории диалога.
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Snapshot in-process метрик (см. src/metrics.ts).
export interface MetricsSnapshot {
  counters: Record<string, number>;
  latencies: Record<
    string,
    {
      count: number;
      p50: number;
      p95: number;
      p99: number;
    }
  >;
  uptime_seconds: number;
  timestamp: string;
}

// Минимальные данные пользователя Telegram, которые мы храним.
export interface BotUserRef {
  userId: number;
  username?: string;
}
