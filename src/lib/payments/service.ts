import "server-only";
import { Prisma, type PrismaClient, type Payment } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanOperateShift, ShiftError, type ShiftActor } from "../shifts/domain";
import { lockShift } from "../shifts/service";
import { assertPayable, authoritativeAmount, normalizePaymentRequest, paymentDetails, PaymentError, paymentFingerprint } from "./domain";

function result(payment: Payment, replayed: boolean) {
  return { id: payment.id, orderId: payment.orderId, method: payment.method, status: payment.status,
    amount: payment.amount, cashReceived: payment.cashReceived, changeAmount: payment.changeAmount,
    edcReference: payment.edcReference, succeededAt: payment.succeededAt?.toISOString() ?? null, replayed };
}
function replay(payment: Payment, fingerprint: string) {
  if (payment.requestFingerprint !== fingerprint || payment.status !== "SUCCEEDED") throw new PaymentError("IDEMPOTENCY_CONFLICT");
  return result(payment, true);
}

/** Internal server API: actor MUST originate from requireUser(), never request data.
 * Invocation confirms cash receipt or approval on the physical EDC terminal.
 * No gateway calls, automatic retries, or printing occur here.
 */
export async function recordManualPayment(db: PrismaClient, actor: ShiftActor, input: unknown) {
  try {
    assertCanOpenShift(actor, null);
    const request = normalizePaymentRequest(input);
    const fingerprint = paymentFingerprint(actor.id, request);
    const lookup = (client: Pick<Prisma.TransactionClient, "payment">) => client.payment.findUnique({ where: { attemptIdentifier: request.attemptIdentifier } });
    const existing = await lookup(db);
    if (existing) return replay(existing, fingerprint);
    try {
      return await db.$transaction(async tx => {
        const target = await tx.order.findUnique({ where: { id: request.orderId }, select: { shiftId: true } });
        if (!target) throw new PaymentError("ORDER_NOT_FOUND");
        const shift = await lockShift(tx, target.shiftId);
        // Recover a committed retry even when its original shift is now closed.
        const committed = await lookup(tx);
        if (committed) return replay(committed, fingerprint);
        assertCanOperateShift(actor, shift);
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${request.orderId}::uuid FOR UPDATE`;
        const order = await tx.order.findUnique({ where: { id: request.orderId }, include: { items: { include: { product: true } } } });
        if (!order) throw new PaymentError("ORDER_NOT_FOUND");
        if (order.shiftId !== shift!.id) throw new PaymentError("FORBIDDEN");
        const payments = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "Payment" WHERE "orderId" = ${order.id}::uuid ORDER BY id FOR UPDATE`;
        assertPayable(order, request.expectedRevision, payments);
        const amount = authoritativeAmount(order);
        const details = paymentDetails(request, amount);
        const succeededAt = new Date();
        const payment = await tx.payment.create({ data: { orderId: order.id, method: request.method,
          status: "SUCCEEDED", amount, attemptIdentifier: request.attemptIdentifier, requestFingerprint: fingerprint,
          ...details, succeededAt } });
        await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: succeededAt, revision: { increment: 1 } } });
        await tx.auditLog.create({ data: { actorId: actor.id, action: "PAYMENT_SUCCEEDED", entityType: "Payment", entityId: payment.id,
          details: { orderId: order.id, shiftId: shift!.id, method: payment.method, amount, revisionBefore: order.revision, revisionAfter: order.revision + 1 } } });
        return result(payment, false);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await lookup(db); // Only after rollback.
        if (winner) return replay(winner, fingerprint);
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (error instanceof ShiftError) throw new PaymentError(error.code === "FORBIDDEN" ? "FORBIDDEN" : "NO_ACTIVE_SHIFT");
    // Commit may have succeeded; callers must recover using the SAME attempt key.
    throw new PaymentError("PAYMENT_FAILED");
  }
}
