import { createHash } from "node:crypto";
import type { OrderType, Product } from "../../generated/prisma/client";

export const MAX_ORDER_MONEY = 2_147_483_647;
export type OrderErrorCode = "INVALID_INPUT" | "INVALID_IDEMPOTENCY_KEY" | "IDEMPOTENCY_CONFLICT" | "NO_ACTIVE_SHIFT" | "FORBIDDEN" | "PRODUCT_NOT_FOUND" | "PRODUCT_UNAVAILABLE" | "INVALID_QUANTITY" | "TOO_MANY_ITEMS" | "MONEY_OVERFLOW" | "CREATE_FAILED";
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
