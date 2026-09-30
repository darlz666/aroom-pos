import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { jakartaBusinessDate } from "./domain";
import { AdjustmentError, adjustmentInput, effectivePaidAt, id, voidInput } from "./adjustment-domain";

export async function authorized<T>(db: PrismaClient, actor: ShiftActor, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  if (!actor || actor.role !== "ADMIN") throw new AdjustmentError("FORBIDDEN");
  const actorId = id(actor.id);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
    const current = await tx.user.findUnique({ where: { id: actorId }, select: { active: true, role: true } });
    if (!current?.active || current.role !== "ADMIN") throw new AdjustmentError("FORBIDDEN");
    return work(tx);
  }, { isolationLevel: "ReadCommitted", timeout: 30000 });
}
async function lockedOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId }, include: {
    transactionVoid: true, adjustments: { orderBy: { revision: "desc" }, take: 1 },
    payments: { where: { status: "SUCCEEDED" } },
  } });
  if (!order || order.status !== "PAID" || !order.payments[0]?.succeededAt) throw new AdjustmentError("CONFLICT");
  return order;
}
export async function adjustTransaction(db: PrismaClient, actor: ShiftActor, input: unknown) {
  return authorized(db, actor, async tx => {
    const request = adjustmentInput(input);
    const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: actor.id, ...request })).digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 925))`;
    const saved = await tx.transactionAdjustment.findUnique({ where: { idempotencyKey: request.idempotencyKey } });
    if (saved) {
      if (saved.requestFingerprint !== fingerprint) throw new AdjustmentError("CONFLICT");
      return { revision: saved.revision, replayed: true };
    }
    const order = await lockedOrder(tx, request.orderId);
    if (order.transactionVoid) throw new AdjustmentError("VOIDED");
    const revision = order.adjustments[0]?.revision ?? 0;
    if (revision !== request.expectedRevision) throw new AdjustmentError("CONFLICT");
    const adjustment = await tx.transactionAdjustment.create({ data: {
      orderId: order.id, revision: revision + 1, actorId: actor.id, idempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint, effectivePaidAt: effectivePaidAt(request.businessDate, order.payments[0].succeededAt!),
      orderNumber: request.orderNumber, channelFee: request.channelFee, reason: request.reason,
      items: { create: request.items.map((item, position) => ({ ...item, position })) },
    } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "TRANSACTION_ADJUSTED", entityType: "Order", entityId: order.id,
      details: { adjustmentId: adjustment.id, revisionBefore: revision, revisionAfter: adjustment.revision, reason: request.reason } } });
    return { revision: adjustment.revision, replayed: false };
  });
}

/** One atomic set; lock in stable order. Existing voids are replay-safe no-ops. */
export async function voidTransactions(db: PrismaClient, actor: ShiftActor, input: unknown) {
  return authorized(db, actor, tx => voidTransactionsInTransaction(tx, actor, input));
}

/** Caller holds the authenticated ADMIN lock through commit. */
export async function voidTransactionsInTransaction(tx: Prisma.TransactionClient, actor: ShiftActor, input: unknown) {
    const request = voidInput(input);
    let created = 0;
    for (const row of request.transactions) {
      const order = await lockedOrder(tx, row.orderId);
      const adjustment = order.adjustments[0];
      if ((adjustment?.revision ?? 0) !== row.expectedRevision ||
        jakartaBusinessDate(adjustment?.effectivePaidAt ?? order.payments[0].succeededAt!) !== request.businessDate) {
        throw new AdjustmentError("CONFLICT");
      }
      if (order.transactionVoid) continue;
      const saved = await tx.transactionVoid.create({ data: { orderId: order.id, actorId: actor.id, reason: request.reason } });
      await tx.auditLog.create({ data: { actorId: actor.id, action: "TRANSACTION_VOIDED", entityType: "Order", entityId: order.id,
        details: { voidId: saved.id, revision: row.expectedRevision, reason: request.reason, businessDate: request.businessDate } } });
      created++;
    }
    return { count: request.transactions.length, created };
}
