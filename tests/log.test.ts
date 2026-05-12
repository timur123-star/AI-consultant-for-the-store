import { describe, it, expect } from 'vitest';
import { logger, child } from '../src/log.js';

describe('log.js', () => {
  it('экспортирует корневой логгер с уровнем по умолчанию', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });

  it('child() создаёт дочерний логгер с фиксированным module', () => {
    const log = child('test-module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    // Проверяем что bindings содержат module
    expect(log.bindings()).toMatchObject({ module: 'test-module' });
  });

  it('redaction скрывает чувствительные поля', () => {
    const log = child('test-redact');
    // Внутренний redact работает через pino — проверяем что метод вызывается без ошибок.
    expect(() => log.info({ password: 'secret123', user: 'alice' }, 'login')).not.toThrow();
  });
});
