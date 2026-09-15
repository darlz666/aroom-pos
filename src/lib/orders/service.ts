import "server-only";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanOperateShift, ShiftError, type ShiftActor } from "../shifts/domain";
import { findActiveShift, lockShift } from "../shifts/service";
import { assertEditable, assertPaymentsAllowMutation, fingerprintCreateRequest, formatOrderNumber, MAX_ORDER_MONEY, normalizeCancelRequest, normalizeCreateRequest, normalizeEditRequest, OrderError, priceOrder, snapshotLineTotal, sumOrderLines } from "./domain";

const orderSelect = {
  id: true, orderNumber: true, status: true, revision: true, shiftId: true,
  cashierId: true, orderType: true, total: true, createdAt: true,
  createRequestFingerprint: true,
  items: { orderBy: { productId: "asc" }, select: {
    id: true, productId: true, productNameSnapshot: true, unitPriceSnapshot: true, quantity: true, lineTotal: true,
  } },
} satisfies Prisma.OrderSelect;
type StoredOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
function result(order: StoredOrder, replayed: boolean) {
  return {
    id: order.id, orderNumber: order.orderNumber, status: order.status, revision: order.revision,
    shiftId: order.shiftId, cashierId: order.cashierId, orderType: order.orderType,
    total: order.total, createdAt: order.createdAt.toISOString(), replayed,
    items: order.items.map((item) => ({ id: item.id, productId: item.productId,
      productName: item.productNameSnapshot, unitPrice: item.unitPriceSnapshot,
      quantity: item.quantity, lineTotal: item.lineTotal })),
  };
}

function mutationResult(order: StoredOrder) {
  const safe = result(order, false);
  // Replay is a create-idempotency concept, not an edit/cancel result field.
  const { replayed: _replayed, ...state } = safe;
  void _replayed;
  return state;
}
export type EditOrderResult = ReturnType<typeof mutationResult>;
export type CancelOrderResult = EditOrderResult;

export type SafeOrder = Omit<EditOrderResult, "replayed">;

function readOrderDto(order: StoredOrder): SafeOrder {
  return mutationResult(order);
}

/** Read only the active, operable shift. The actor is always server-authenticated. */
async function operableShift(db: PrismaClient, actor: ShiftActor) {
  try {
    assertCanOpenShift(actor, null);
    const shift = await findActiveShift(db);
    assertCanOperateShift(actor, shift);
    return shift!;
  } catch (error) { mutationError(error, "UPDATE_FAILED"); }
}

export async function listActiveUnpaidOrders(db: PrismaClient, actor: ShiftActor): Promise<SafeOrder[]> {
  const shift = await operableShift(db, actor);
  const orders = await db.order.findMany({
    where: { shiftId: shift.id, status: "UNPAID" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: orderSelect,
  });
  return orders.map(readOrderDto);
}

export async function getActiveUnpaidOrder(db: PrismaClient, actor: ShiftActor, orderId: string): Promise<SafeOrder> {
  if (typeof orderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    throw new OrderError("INVALID_INPUT");
  }
  const shift = await operableShift(db, actor);
  const order = await db.order.findFirst({ where: { id: orderId.toLowerCase(), shiftId: shift.id, status: "UNPAID" }, select: orderSelect });
  if (!order) throw new OrderError("ORDER_NOT_FOUND");
  return readOrderDto(order);
}

/** Shift discovery is never authorization. All writers must follow this lock order. */
async function lockMutableOrder(tx: Prisma.TransactionClient, actor: ShiftActor, request: { orderId: string; expectedRevision: number }) {
  const target = await tx.order.findUnique({ where: { id: request.orderId }, select: { shiftId: true } });
  if (!target) throw new OrderError("ORDER_NOT_FOUND");
  const shift = await lockShift(tx, target.shiftId);
  assertCanOperateShift(actor, shift);
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Order" WHERE id = ${request.orderId}::uuid FOR UPDATE`;
  if (!locked.length) throw new OrderError("ORDER_NOT_FOUND");
  const order = await tx.order.findUnique({ where: { id: request.orderId }, select: orderSelect });
  if (!order || order.id !== request.orderId) throw new OrderError("ORDER_NOT_FOUND");
  if (order.shiftId !== shift!.id) throw new OrderError("FORBIDDEN");
  assertEditable(order, request.expectedRevision);
  const payments = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM "Payment" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE
  `;
  assertPaymentsAllowMutation(payments);
  return { order, shift: shift! };
}

function mutationError(error: unknown, fallback: "UPDATE_FAILED" | "CANCEL_FAILED"): never {
  if (error instanceof OrderError) throw error;
  if (error instanceof ShiftError) throw new OrderError(error.code === "FORBIDDEN" ? "FORBIDDEN" : "NO_ACTIVE_SHIFT");
  throw new OrderError(fallback);
}

/** Internal server API; actor comes exclusively from authenticated server code. */
export async function editOrder(db: PrismaClient, actor: ShiftActor, input: unknown): Promise<EditOrderResult> {
  try {
    assertCanOpenShift(actor, null);
    const request = normalizeEditRequest(input);
    return await db.$transaction(async (tx) => {
      const { order, shift } = await lockMutableOrder(tx, actor, request);
      const operation = request.operation;
      const existing = operation.type === "ADD_ITEM" ? undefined : order.items.find((item) => item.id === operation.orderItemId);
      if (operation.type !== "ADD_ITEM" && !existing) throw new OrderError("ORDER_ITEM_NOT_FOUND");
      if (operation.type === "SET_QUANTITY" && existing!.quantity === operation.quantity) return mutationResult(order);
      if (order.revision === MAX_ORDER_MONEY) throw new OrderError("UPDATE_FAILED");
      let changedLine: Prisma.InputJsonObject;
      if (operation.type === "ADD_ITEM") {
        const products = await tx.product.findMany({ where: { id: operation.productId },
          select: { id: true, name: true, price: true, active: true, available: true } });
        const [snapshot] = priceOrder([{ productId: operation.productId, quantity: operation.quantity }], products).items;
        // Always append: even identical snapshots remain deterministic independent lines.
        const line = await tx.orderItem.create({ data: { orderId: order.id, ...snapshot }, select: { id: true } });
        changedLine = { orderItemId: line.id, before: null, after: snapshot };
      } else if (operation.type === "SET_QUANTITY") {
        if (operation.quantity > existing!.quantity) {
          const product = await tx.product.findUnique({ where: { id: existing!.productId }, select: { active: true, available: true } });
          if (!product) throw new OrderError("PRODUCT_NOT_FOUND");
          if (!product.active || !product.available) throw new OrderError("PRODUCT_UNAVAILABLE");
        }
        const lineTotal = snapshotLineTotal(existing!.unitPriceSnapshot, operation.quantity);
        await tx.orderItem.update({ where: { id: existing!.id }, data: { quantity: operation.quantity, lineTotal } });
        changedLine = { orderItemId: existing!.id, productId: existing!.productId,
          before: { quantity: existing!.quantity, lineTotal: existing!.lineTotal },
          after: { quantity: operation.quantity, lineTotal } };
      } else {
        if (order.items.length === 1) throw new OrderError("EMPTY_ORDER_NOT_ALLOWED");
        await tx.orderItem.delete({ where: { id: existing!.id } });
        changedLine = { orderItemId: existing!.id, before: { productId: existing!.productId,
          productNameSnapshot: existing!.productNameSnapshot, unitPriceSnapshot: existing!.unitPriceSnapshot,
          quantity: existing!.quantity, lineTotal: existing!.lineTotal }, after: null };
      }
      const total = sumOrderLines(await tx.orderItem.findMany({ where: { orderId: order.id }, select: { lineTotal: true } }));
      const updated = await tx.order.update({ where: { id: order.id }, data: { total, revision: { increment: 1 } }, select: orderSelect });
      await tx.auditLog.create({ data: { action: "ORDER_UPDATED", entityType: "Order", entityId: order.id, actorId: actor.id,
        details: { orderNumber: order.orderNumber, shiftId: shift.id, shiftOwnerId: shift.cashierId, editingActorId: actor.id,
          revisionBefore: order.revision, revisionAfter: updated.revision, totalBefore: order.total, totalAfter: total,
          operation: operation.type, changedLine } } });
      return mutationResult(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) { mutationError(error, "UPDATE_FAILED"); }
}

/** Cancel preserves receipt snapshots, totals and original ownership permanently. */
export async function cancelOrder(db: PrismaClient, actor: ShiftActor, input: unknown): Promise<CancelOrderResult> {
  try {
    assertCanOpenShift(actor, null);
    const request = normalizeCancelRequest(input);
    return await db.$transaction(async (tx) => {
      const { order, shift } = await lockMutableOrder(tx, actor, request);
      if (order.revision === MAX_ORDER_MONEY) throw new OrderError("CANCEL_FAILED");
      const cancelledAt = new Date();
      const cancelled = await tx.order.update({ where: { id: order.id },
        data: { status: "CANCELLED", cancelledAt, revision: { increment: 1 } }, select: orderSelect });
      await tx.auditLog.create({ data: { action: "ORDER_CANCELLED", entityType: "Order", entityId: order.id, actorId: actor.id,
        details: { orderNumber: order.orderNumber, shiftId: shift.id, shiftOwnerId: shift.cashierId, cancellingActorId: actor.id,
          revisionBefore: order.revision, revisionAfter: cancelled.revision, total: order.total,
          cancelledAt: cancelledAt.toISOString(), reason: request.cancellationReason } } });
      return mutationResult(cancelled);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) { mutationError(error, "CANCEL_FAILED"); }
}
export type CreateOrderResult = ReturnType<typeof result>;
function replay(order: StoredOrder, actor: ShiftActor, fingerprint: string): CreateOrderResult {
  if (order.cashierId !== actor.id || order.createRequestFingerprint !== fingerprint) throw new OrderError("IDEMPOTENCY_CONFLICT");
  return result(order, true);
}

/** Internal server API. A future entrypoint MUST supply a freshly authenticated actor. */
export async function createOrder(db: PrismaClient, actor: ShiftActor, input: unknown): Promise<CreateOrderResult> {
  try {
    assertCanOpenShift(actor, null); // Reuse role/actor validation; no shift required for replay.
    const request = normalizeCreateRequest(input);
    const fingerprint = fingerprintCreateRequest(request);
    const lookup = (client: Pick<Prisma.TransactionClient, "order">) => client.order.findUnique({
      where: { createIdempotencyKey: request.createIdempotencyKey }, select: orderSelect,
    });
    const existing = await lookup(db);
    if (existing) return replay(existing, actor, fingerprint);
    try {
      return await db.$transaction(async (tx) => {
        const active = await findActiveShift(tx);
        const shift = active ? await lockShift(tx, active.id) : null;
        // A committed replay needs no currently operable shift, including after waiting.
        const committed = await lookup(tx);
        if (committed) return replay(committed, actor, fingerprint);
        assertCanOperateShift(actor, shift);
        const products = await tx.product.findMany({ where: { id: { in: request.items.map((item) => item.productId) } },
          select: { id: true, name: true, price: true, active: true, available: true } });
        const priced = priceOrder(request.items, products);
        const [sequence] = await tx.$queryRaw<{ value: bigint }[]>`SELECT nextval('order_number_seq') AS value`;
        const order = await tx.order.create({ data: {
          orderNumber: formatOrderNumber(sequence.value), shiftId: shift!.id, cashierId: actor.id,
          status: "UNPAID", revision: 1, orderType: request.orderType, total: priced.total,
          createIdempotencyKey: request.createIdempotencyKey, createRequestFingerprint: fingerprint,
          paidAt: null, cancelledAt: null, items: { create: priced.items },
        }, select: orderSelect });
        await tx.auditLog.create({ data: {
          action: "ORDER_CREATED", entityType: "Order", entityId: order.id, actorId: actor.id,
          details: { orderNumber: order.orderNumber, shiftId: shift!.id, shiftOwnerId: shift!.cashierId,
            creatorId: actor.id, orderType: order.orderType, revision: order.revision,
            total: order.total, items: priced.items },
        } });
        return result(order, false);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Query only after rollback: PostgreSQL aborts a transaction on constraint failure.
        const winner = await lookup(db);
        if (winner) return replay(winner, actor, fingerprint);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof OrderError) throw error;
    if (error instanceof ShiftError) throw new OrderError(error.code === "FORBIDDEN" ? "FORBIDDEN" : "NO_ACTIVE_SHIFT");
    // Includes interrupted connections and commit uncertainty; retry the SAME key.
    throw new OrderError("CREATE_FAILED");
  }
}
