import { createHash } from "node:crypto";
import type { OrderType, Product } from "../../generated/prisma/client";

export const MAX_ORDER_MONEY = 2_147_483_647;
export type OrderErrorCode = "INVALID_INPUT" | "INVALID_IDEMPOTENCY_KEY" | "IDEMPOTENCY_CONFLICT" | "NO_ACTIVE_SHIFT" | "FORBIDDEN" | "PRODUCT_NOT_FOUND" | "PRODUCT_UNAVAILABLE" | "INVALID_QUANTITY" | "TOO_MANY_ITEMS" | "MONEY_OVERFLOW" | "CREATE_FAILED" | "ORDER_NOT_FOUND" | "ORDER_NOT_EDITABLE" | "REVISION_CONFLICT" | "ORDER_ITEM_NOT_FOUND" | "EMPTY_ORDER_NOT_ALLOWED" | "PAYMENT_BLOCKED" | "UPDATE_FAILED" | "CANCEL_FAILED";
export class OrderError extends Error {
  constructor(public readonly code: OrderErrorCode) {
    super(code);
    this.name = "OrderError";
  }
}

export type CreateOrderInput = {
  createIdempotencyKey: string;
  orderType: OrderType;
  items: { productId: string; quantity: number }[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new OrderError("INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}

export function normalizeCreateRequest(input: unknown): CreateOrderInput {
  const request = object(input, ["createIdempotencyKey", "orderType", "items"]);
  if (typeof request.createIdempotencyKey !== "string" || !uuid.test(request.createIdempotencyKey)) throw new OrderError("INVALID_IDEMPOTENCY_KEY");
  if (request.orderType !== "DINE_IN" && request.orderType !== "TAKEAWAY") throw new OrderError("INVALID_INPUT");
  if (!Array.isArray(request.items) || request.items.length === 0) throw new OrderError("INVALID_INPUT");
  const quantities = new Map<string, number>();
  for (const raw of request.items) {
    const item = object(raw, ["productId", "quantity"]);
    if (typeof item.productId !== "string" || !uuid.test(item.productId)) throw new OrderError("INVALID_INPUT");
    if (typeof item.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new OrderError("INVALID_QUANTITY");
    const productId = item.productId.toLowerCase();
    const quantity = (quantities.get(productId) ?? 0) + item.quantity;
    if (quantity > 99) throw new OrderError("INVALID_QUANTITY");
    quantities.set(productId, quantity);
    if (quantities.size > 100) throw new OrderError("TOO_MANY_ITEMS");
  }
  return {
    // PostgreSQL UUID storage canonicalizes case; preserve the UUID value.
    createIdempotencyKey: request.createIdempotencyKey.toLowerCase(),
    orderType: request.orderType,
    items: [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([productId, quantity]) => ({ productId, quantity })),
  };
}

/** Original normalized intent only, independent of menu and shift changes. */
export function fingerprintCreateRequest(request: CreateOrderInput): string {
  return createHash("sha256").update(JSON.stringify({ orderType: request.orderType, items: request.items })).digest("hex");
}

type OrderProduct = Pick<Product, "id" | "name" | "price" | "active" | "available">;
export function priceOrder(items: CreateOrderInput["items"], products: OrderProduct[]) {
  const byId = new Map(products.map((product) => [product.id, product]));
  let total = 0;
  const snapshots = items.map(({ productId, quantity }) => {
    const product = byId.get(productId);
    if (!product) throw new OrderError("PRODUCT_NOT_FOUND");
    if (!product.active || !product.available) throw new OrderError("PRODUCT_UNAVAILABLE");
    const price = product.price;
    if (!Number.isInteger(price) || price < 0 || price > MAX_ORDER_MONEY || price > Math.floor(MAX_ORDER_MONEY / quantity)) throw new OrderError("MONEY_OVERFLOW");
    const lineTotal = price * quantity;
    if (total > MAX_ORDER_MONEY - lineTotal) throw new OrderError("MONEY_OVERFLOW");
    total += lineTotal;
    return { productId, productNameSnapshot: product.name, unitPriceSnapshot: price, quantity, lineTotal };
  });
  return { items: snapshots, total };
}

export function formatOrderNumber(value: bigint): string {
  if (value < BigInt(1)) throw new OrderError("CREATE_FAILED");
  return `AR-${value.toString().padStart(6, "0")}`;
}

export type EditOperation =
  | { type: "ADD_ITEM"; productId: string; quantity: number }
  | { type: "SET_QUANTITY"; orderItemId: string; quantity: number }
  | { type: "REMOVE_ITEM"; orderItemId: string };
export type EditOrderInput = { orderId: string; expectedRevision: number; operation: EditOperation };
export type CancelOrderInput = { orderId: string; expectedRevision: number; cancellationReason?: string };

function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new OrderError("INVALID_INPUT");
  return value.toLowerCase();
}
function quantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) throw new OrderError("INVALID_QUANTITY");
  return value;
}
function mutationIdentity(request: Record<string, unknown>) {
  const orderId = identifier(request.orderId);
  const expectedRevision = request.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new OrderError("INVALID_INPUT");
  return { orderId, expectedRevision };
}
export function normalizeEditRequest(input: unknown): EditOrderInput {
  const request = object(input, ["orderId", "expectedRevision", "operation"]);
  const identity = mutationIdentity(request);
  const op = object(request.operation, ["type", "productId", "orderItemId", "quantity"]);
  if (op.type === "ADD_ITEM") {
    object(op, ["type", "productId", "quantity"]);
    return { ...identity, operation: { type: op.type, productId: identifier(op.productId), quantity: quantity(op.quantity) } };
  }
  if (op.type === "SET_QUANTITY") {
    object(op, ["type", "orderItemId", "quantity"]);
    return { ...identity, operation: { type: op.type, orderItemId: identifier(op.orderItemId), quantity: quantity(op.quantity) } };
  }
  if (op.type === "REMOVE_ITEM") {
    object(op, ["type", "orderItemId"]);
    return { ...identity, operation: { type: op.type, orderItemId: identifier(op.orderItemId) } };
  }
  throw new OrderError("INVALID_INPUT");
}
export function normalizeCancelRequest(input: unknown) {
  const request = object(input, ["orderId", "expectedRevision", "cancellationReason"]);
  const identity = mutationIdentity(request);
  const reason = request.cancellationReason;
  if (reason !== undefined && typeof reason !== "string") throw new OrderError("INVALID_INPUT");
  const cancellationReason = typeof reason === "string" ? reason.trim() || null : null;
  if (cancellationReason && [...cancellationReason].length > 500) throw new OrderError("INVALID_INPUT");
  return { ...identity, cancellationReason };
}

export function assertEditable(order: { status: string; revision: number }, expectedRevision: number): void {
  if (order.status !== "UNPAID") throw new OrderError("ORDER_NOT_EDITABLE");
  if (order.revision !== expectedRevision) throw new OrderError("REVISION_CONFLICT");
}
export function assertPaymentsAllowMutation(payments: { status: string }[]): void {
  if (payments.some(({ status }) => status === "PENDING" || status === "SUCCEEDED")) throw new OrderError("PAYMENT_BLOCKED");
}
export function snapshotLineTotal(unitPrice: number, newQuantity: number): number {
  quantity(newQuantity);
  if (!Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > Math.floor(MAX_ORDER_MONEY / newQuantity)) throw new OrderError("MONEY_OVERFLOW");
  return unitPrice * newQuantity;
}
export function sumOrderLines(items: { lineTotal: number }[]): number {
  if (!items.length) throw new OrderError("EMPTY_ORDER_NOT_ALLOWED");
  let total = 0;
  for (const { lineTotal } of items) {
    if (!Number.isInteger(lineTotal) || lineTotal < 0 || lineTotal > MAX_ORDER_MONEY - total) throw new OrderError("MONEY_OVERFLOW");
    total += lineTotal;
  }
  return total;
}
