// Бизнес-логика статусов заказа: допустимые статусы, мапа для отображения
// и текст-уведомление клиенту при смене статуса.
//
// Pipeline:
//   new → pending_payment (если payments активны)
//   pending_payment → paid (после successful_payment)
//   paid | new → confirmed → shipped → delivered (или cancelled на любом этапе)
export const VALID_STATUSES = [
  'new',
  'pending_payment',
  'paid',
  'confirmed',
  'shipped',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof VALID_STATUSES)[number];
export const VALID_STATUS_SET: ReadonlySet<string> = new Set(VALID_STATUSES);

export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: '🆕 Новый',
  pending_payment: '💳 Ожидает оплаты',
  paid: '💰 Оплачен',
  confirmed: '✅ Подтверждён',
  shipped: '📦 Отправлен',
  delivered: '🎉 Доставлен',
  cancelled: '❌ Отменён',
};

// Возвращает сообщение, которое отправляется клиенту, когда менеджер
// меняет статус заказа.
export function statusUpdateMessage(orderId: number, status: string): string {
  switch (status) {
    case 'paid':
      return `💰 Оплата заказа #${orderId} получена. Менеджер скоро свяжется для уточнения адреса.`;
    case 'confirmed':
      return `✅ Твой заказ #${orderId} подтверждён. Менеджер скоро свяжется для уточнения адреса.`;
    case 'shipped':
      return `📦 Твой заказ #${orderId} отправлен! Ждать 2-7 дней по России.`;
    case 'delivered':
      return `🎉 Твой заказ #${orderId} доставлен. Спасибо что был с нами!`;
    case 'cancelled':
      return `❌ Твой заказ #${orderId} отменён. Если это ошибка — напиши менеджеру.`;
    default:
      return `Статус заказа #${orderId}: ${STATUS_LABELS[status as OrderStatus] || status}`;
  }
}
