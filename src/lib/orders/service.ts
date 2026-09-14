import "server-only";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanOperateShift, ShiftError, type ShiftActor } from "../shifts/domain";
import { findActiveShift, lockShift } from "../shifts/service";
import { fingerprintCreateRequest, formatOrderNumber, normalizeCreateRequest, OrderError, priceOrder } from "./domain";

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
