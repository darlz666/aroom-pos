import "server-only";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanViewShift, shiftHistoryWhere, ShiftError, type ShiftActor } from "../shifts/domain";
import { OrderError } from "./domain";

export type OrderHistoryCursor = { createdAt: string; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new OrderError("INVALID_INPUT");
  return value.toLowerCase();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new OrderError("INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}
function historyRequest(input: unknown) {
  const raw = object(input, ["limit", "cursor", "orderNumber"]);
  const limit = raw.limit === undefined ? 25 : raw.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new OrderError("INVALID_INPUT");
  let cursor: OrderHistoryCursor | undefined;
  if (raw.cursor !== undefined) {
    const value = object(raw.cursor, ["createdAt", "id"]);
    if (typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
        !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
      throw new OrderError("INVALID_INPUT");
    }
    cursor = { id: identifier(value.id), createdAt: value.createdAt };
  }
  let orderNumber: string | undefined;
  if (raw.orderNumber !== undefined) {
    if (typeof raw.orderNumber !== "string" || raw.orderNumber.length > 64) throw new OrderError("INVALID_INPUT");
    orderNumber = raw.orderNumber.trim().toUpperCase();
    if (!/^AR-\d{6,19}$/.test(orderNumber)) throw new OrderError("INVALID_INPUT");
  }
  return { limit, cursor, orderNumber };
}

const summarySelect = {
  id: true, orderNumber: true, status: true, orderType: true, total: true,
  createdAt: true, paidAt: true, cancelledAt: true,
  cashier: { select: { id: true, name: true } },
  shift: { select: { id: true, cashierId: true, status: true, openedAt: true, closedAt: true,
    cashier: { select: { id: true, name: true } } } },
} satisfies Prisma.OrderSelect;

function summary(order: Prisma.OrderGetPayload<{ select: typeof summarySelect }>) {
  return {
    id: order.id, orderNumber: order.orderNumber, status: order.status, orderType: order.orderType,
    total: order.total, createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null, cancelledAt: order.cancelledAt?.toISOString() ?? null,
    cashier: { id: order.cashier.id, name: order.cashier.name },
    shift: { id: order.shift.id, status: order.shift.status, openedAt: order.shift.openedAt.toISOString(),
      closedAt: order.shift.closedAt?.toISOString() ?? null,
      cashier: { id: order.shift.cashier.id, name: order.shift.cashier.name } },
  };
}
function readFailure(error: unknown): never {
  if (error instanceof OrderError) throw error;
  if (error instanceof ShiftError && error.code === "FORBIDDEN") throw new OrderError("FORBIDDEN");
  throw new OrderError("UPDATE_FAILED");
}

/** Read-only server API. Actor must come from fresh authentication.
 * Cursor is a position, never authorization. New inserts do not shift later pages.
 * Each page is a fresh read, not a frozen snapshot of the entire history. */
export async function listOrderHistory(db: PrismaClient, actor: ShiftActor, input: unknown = {}) {
  try {
    const visibility = shiftHistoryWhere(actor);
    const { limit, cursor, orderNumber } = historyRequest(input);
    const rows = await db.order.findMany({
      where: { shift: visibility, ...(orderNumber ? { orderNumber } : {}),
        ...(cursor ? { OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: summarySelect,
    });
    const orders = rows.slice(0, limit).map(summary);
    const last = orders.at(-1);
    const nextCursor: OrderHistoryCursor | null = rows.length > limit && last
      ? { createdAt: last.createdAt, id: last.id } : null;
    return { orders, nextCursor };
  } catch (error) { readFailure(error); }
}

/** Historical visibility follows Shift.cashierId, not the order's creator. */
export async function getHistoricalOrder(db: PrismaClient, actor: ShiftActor, orderId: unknown) {
  try {
    assertCanOpenShift(actor, null); // Actor validation only; history needs no OPEN shift.
    const id = identifier(orderId);
    const order = await db.order.findUnique({ where: { id }, select: {
      ...summarySelect,
      items: { orderBy: [{ productId: "asc" }, { id: "asc" }], select: {
        id: true, productId: true, productNameSnapshot: true, unitPriceSnapshot: true,
        quantity: true, notes: true, lineTotal: true,
      } },
      payments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
        id: true, method: true, status: true, amount: true, cashReceived: true, changeAmount: true,
        edcReference: true, createdAt: true, updatedAt: true, succeededAt: true,
      } },
    } });
    if (!order) throw new OrderError("ORDER_NOT_FOUND");
    assertCanViewShift(actor, order.shift);
    return { ...summary(order),
      items: order.items.map(item => ({ id: item.id, productId: item.productId,
        productName: item.productNameSnapshot, unitPrice: item.unitPriceSnapshot,
        quantity: item.quantity, notes: item.notes, lineTotal: item.lineTotal })),
      payments: order.payments.map(payment => ({ id: payment.id, method: payment.method,
        status: payment.status, amount: payment.amount, cashReceived: payment.cashReceived,
        changeAmount: payment.changeAmount, edcReference: payment.edcReference,
        createdAt: payment.createdAt.toISOString(), updatedAt: payment.updatedAt.toISOString(),
        succeededAt: payment.succeededAt?.toISOString() ?? null })),
    };
  } catch (error) { readFailure(error); }
}
