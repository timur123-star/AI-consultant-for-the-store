// Структурированные логи через pino:
// — в production пишем JSON в stdout (Railway сам парсит и индексирует);
// — локально (NODE_ENV !== 'production') используем pino-pretty для читаемого вывода.
import pino, { type Logger } from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
  // Не логируем потенциальные секреты, даже если кто-то их случайно передал.
  redact: {
    paths: [
      '*.password',
      '*.token',
      '*.apiKey',
      '*.api_key',
      '*.authorization',
      '*.Authorization',
      'req.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
});

// Хелпер: дочерний логгер с фиксированным модулем — упрощает фильтрацию в Railway.
export function child(module: string): Logger {
  return logger.child({ module });
}
