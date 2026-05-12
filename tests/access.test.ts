import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const REQUIRED_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  GROQ_API_KEY: 'gsk_test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
};

async function loadAccess() {
  // resetModules сбрасывает и config.js — он перечитает process.env заново.
  vi.resetModules();
  return import('../src/access.js');
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ...REQUIRED_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('access', () => {
  it('isAdmin == true только для admin_user_id', async () => {
    process.env.ADMIN_USER_ID = '777';
    const { isAdmin } = await loadAccess();
    expect(isAdmin(777)).toBe(true);
    expect(isAdmin('777')).toBe(true);
    expect(isAdmin(123)).toBe(false);
  });

  it('isManager == true для admin или manager_chat_id', async () => {
    process.env.ADMIN_USER_ID = '777';
    process.env.MANAGER_CHAT_ID = '888';
    const { isManager } = await loadAccess();
    expect(isManager(777)).toBe(true);
    expect(isManager(888)).toBe(true);
    expect(isManager(999)).toBe(false);
  });

  it('без admin/manager в env все возвращают false', async () => {
    delete process.env.ADMIN_USER_ID;
    delete process.env.MANAGER_CHAT_ID;
    const { isAdmin, isManager } = await loadAccess();
    expect(isAdmin(1)).toBe(false);
    expect(isManager(1)).toBe(false);
  });
});
