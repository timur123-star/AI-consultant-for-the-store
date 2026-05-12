// Стандартные значения env для тестов: чтобы модули типа src/config.js не падали
// на этапе импорта, когда тест проверяет НЕ конфигурацию. Тесты config.test.js
// перетирают эти значения в своих beforeEach.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Тесты не должны спамить структурированные логи — отключаем уровень "info".
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
