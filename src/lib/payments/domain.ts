import { createHash } from "node:crypto";
import { MAX_ORDER_MONEY, snapshotLineTotal, sumOrderLines } from "../orders/domain";

export class PaymentError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "FORBIDDEN" | "NO_ACTIVE_SHIFT" | "ORDER_NOT_FOUND" | "ORDER_NOT_PAYABLE" | "REVISION_CONFLICT" | "PAYMENT_BLOCKED" | "IDEMPOTENCY_CONFLICT" | "PRODUCT_UNAVAILABLE" | "PRICE_CHANGED" | "INVALID_ORDER_TOTAL" | "INSUFFICIENT_CASH" | "PAYMENT_FAILED") {
    super(code);
    this.name = "PaymentError";
  }
}
type Identity = { orderId: string; expectedRevision: number; attemptIdentifier: string };
export type PaymentInput = Identity & (
  { method: "CASH"; cashReceived: number } |
  { method: "BCA_EDC"; edcReference: string | null }
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizePaymentRequest(input: unknown): PaymentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PaymentError("INVALID_INPUT");
  const raw = input as Record<string, unknown>;
  const keys = ["orderId", "expectedRevision", "attemptIdentifier", "method", raw.method === "CASH" ? "cashReceived" : "edcReference"];
  if (Object.keys(raw).some(key => !keys.includes(key)) ||
      typeof raw.orderId !== "string" || !uuid.test(raw.orderId) ||
      typeof raw.attemptIdentifier !== "string" || !uuid.test(raw.attemptIdentifier) ||
      typeof raw.expectedRevision !== "number" || !Number.isInteger(raw.expectedRevision) ||
      raw.expectedRevision < 1 || raw.expectedRevision >= MAX_ORDER_MONEY) throw new PaymentError("INVALID_INPUT");
  const identity = { orderId: raw.orderId.toLowerCase(), attemptIdentifier: raw.attemptIdentifier.toLowerCase(), expectedRevision: raw.expectedRevision };
  if (raw.method === "CASH") {
    if (typeof raw.cashReceived !== "number" || !Number.isInteger(raw.cashReceived) || raw.cashReceived < 0 || raw.cashReceived > MAX_ORDER_MONEY) throw new PaymentError("INVALID_INPUT");
    return { ...identity, method: "CASH", cashReceived: raw.cashReceived };
  }
  if (raw.method !== "BCA_EDC" || (raw.edcReference !== undefined && typeof raw.edcReference !== "string")) throw new PaymentError("INVALID_INPUT");
  const edcReference = typeof raw.edcReference === "string" ? raw.edcReference.trim() || null : null;
  if (edcReference && [...edcReference].length > 100) throw new PaymentError("INVALID_INPUT");
  return { ...identity, method: "BCA_EDC", edcReference };
}
export function paymentFingerprint(actorId: string, request: PaymentInput): string {
  return createHash("sha256").update(JSON.stringify({ actorId, ...request })).digest("hex");
}
export function assertPayable(order: { status: string; revision: number }, expectedRevision: number, payments: { status: string }[]): void {
  if (order.status !== "UNPAID") throw new PaymentError("ORDER_NOT_PAYABLE");
  if (order.revision !== expectedRevision) throw new PaymentError("REVISION_CONFLICT");
  if (payments.some(p => p.status === "PENDING" || p.status === "SUCCEEDED")) throw new PaymentError("PAYMENT_BLOCKED");
}
type PaymentLine = { unitPriceSnapshot: number; quantity: number; lineTotal: number; product: { price: number; active: boolean; available: boolean } };
export function authoritativeAmount(order: { total: number; items: PaymentLine[] }): number {
  try {
    for (const item of order.items) {
      if (snapshotLineTotal(item.unitPriceSnapshot, item.quantity) !== item.lineTotal) throw new PaymentError("INVALID_ORDER_TOTAL");
      if (!item.product.active || !item.product.available) throw new PaymentError("PRODUCT_UNAVAILABLE");
      if (item.product.price !== item.unitPriceSnapshot) throw new PaymentError("PRICE_CHANGED");
    }
    const total = sumOrderLines(order.items);
    if (total !== order.total) throw new PaymentError("INVALID_ORDER_TOTAL");
    return total;
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    throw new PaymentError("INVALID_ORDER_TOTAL");
  }
}
export function paymentDetails(request: PaymentInput, amount: number) {
  if (request.method === "CASH") {
    if (request.cashReceived < amount) throw new PaymentError("INSUFFICIENT_CASH");
    return { cashReceived: request.cashReceived, changeAmount: request.cashReceived - amount, edcReference: null };
  }
  return { cashReceived: null, changeAmount: null, edcReference: request.edcReference };
}
