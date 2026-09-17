import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanViewShift, ShiftError, type ShiftActor } from "../shifts/domain";
import { OrderError } from "./domain";

/** Read projection only. Actor must come from fresh server authentication. */
export async function getReceipt(db: PrismaClient, actor: ShiftActor, orderId: string) {
  try {
    assertCanOpenShift(actor, null);
    if (typeof orderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      throw new OrderError("INVALID_INPUT");
    }
    const order = await db.order.findUnique({
      where: { id: orderId.toLowerCase() },
      select: {
        shift: { select: { cashierId: true } }, status: true, orderNumber: true, orderType: true,
        cashier: { select: { name: true } }, createdAt: true, paidAt: true, total: true,
        items: { orderBy: [{ productId: "asc" }, { id: "asc" }], select: {
          productNameSnapshot: true, unitPriceSnapshot: true, quantity: true, lineTotal: true,
        } },
        payments: { where: { status: "SUCCEEDED" }, select: {
          method: true, amount: true, cashReceived: true, changeAmount: true,
          edcReference: true, succeededAt: true,
        } },
      },
    });
    if (!order) throw new OrderError("ORDER_NOT_FOUND");
    assertCanViewShift(actor, order.shift);
    const payment = order.payments[0];
    if (order.status !== "PAID" || !payment) throw new OrderError("ORDER_NOT_FOUND");
    return {
      orderNumber: order.orderNumber, orderType: order.orderType, cashier: order.cashier.name,
      createdAt: order.createdAt.toISOString(), paidAt: order.paidAt?.toISOString() ?? null,
      total: order.total,
      items: order.items.map((item) => ({ name: item.productNameSnapshot,
        unitPrice: item.unitPriceSnapshot, quantity: item.quantity, lineTotal: item.lineTotal })),
      payment: {
        method: payment.method, amount: payment.amount, cashReceived: payment.cashReceived,
        changeAmount: payment.changeAmount, edcReference: payment.edcReference,
        succeededAt: payment.succeededAt?.toISOString() ?? null,
      },
    };
  } catch (error) {
    if (error instanceof OrderError) throw error;
    if (error instanceof ShiftError && error.code === "FORBIDDEN") throw new OrderError("FORBIDDEN");
    throw new OrderError("UPDATE_FAILED");
  }
}
