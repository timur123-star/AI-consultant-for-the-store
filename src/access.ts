// Проверки прав доступа: админ — может /reindex, /stats; менеджер — может /orders, /search,
// управлять заказами через инлайн-кнопки. ID сравниваем как строки, чтобы быть
// устойчивыми к разнице между Number и String из env.
import { config } from './config.js';

export function isAdmin(userId: number | string | undefined): boolean {
  return Boolean(config.adminUserId) && String(userId) === String(config.adminUserId);
}

export function isManager(userId: number | string | undefined): boolean {
  return (
    isAdmin(userId) ||
    (Boolean(config.managerChatId) && String(userId) === String(config.managerChatId))
  );
}
