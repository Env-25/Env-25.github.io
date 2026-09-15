/** Shared order status labels for admin + account pages. */

export const ORDER_STATUS = {
  PAYMENT_PENDING: "payment_pending",
  PAYMENT_RECEIVED: "payment_received",
  ORDER_READY: "order_ready",
  ORDER_COMPLETED: "order_completed",
  CANCELLED: "cancelled",
} as const;

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export const ADMIN_ORDER_STATUSES: OrderStatus[] = [
  ORDER_STATUS.PAYMENT_PENDING,
  ORDER_STATUS.PAYMENT_RECEIVED,
  ORDER_STATUS.ORDER_READY,
  ORDER_STATUS.ORDER_COMPLETED,
  ORDER_STATUS.CANCELLED,
];

export function normalizeOrderStatus(status: unknown): OrderStatus {
  if (status === 0 || status === "0") return ORDER_STATUS.CANCELLED;
  if (status === 1 || status === "1") return ORDER_STATUS.PAYMENT_PENDING;
  if (status === 2 || status === "2") return ORDER_STATUS.ORDER_COMPLETED;
  const value = String(status || "").trim();
  if ((Object.values(ORDER_STATUS) as string[]).includes(value)) return value as OrderStatus;
  return ORDER_STATUS.PAYMENT_PENDING;
}

export function orderStatusLabel(status: unknown): string {
  switch (normalizeOrderStatus(status)) {
    case ORDER_STATUS.PAYMENT_PENDING:
      return "Payment pending";
    case ORDER_STATUS.PAYMENT_RECEIVED:
      return "Payment received";
    case ORDER_STATUS.ORDER_READY:
      return "Order ready";
    case ORDER_STATUS.ORDER_COMPLETED:
      return "Order completed";
    case ORDER_STATUS.CANCELLED:
      return "Order cancelled";
    default:
      return "Payment pending";
  }
}

export function orderStatusClass(status: unknown): string {
  switch (normalizeOrderStatus(status)) {
    case ORDER_STATUS.CANCELLED:
      return "is-cancelled";
    case ORDER_STATUS.ORDER_COMPLETED:
      return "is-done";
    case ORDER_STATUS.ORDER_READY:
      return "is-ready";
    case ORDER_STATUS.PAYMENT_RECEIVED:
      return "is-paid";
    default:
      return "is-open";
  }
}

export function isActiveOrderStatus(status: unknown): boolean {
  const normalized = normalizeOrderStatus(status);
  return (
    normalized === ORDER_STATUS.PAYMENT_PENDING ||
    normalized === ORDER_STATUS.PAYMENT_RECEIVED ||
    normalized === ORDER_STATUS.ORDER_READY
  );
}
