import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import { calculateExpectedCash, ShiftError } from "./domain";

/** Internal read-only helper. Callers must authorize access to the shift server-side. */
export async function getShiftSettlement(db: PrismaClient, shiftId: string) {
  if (typeof shiftId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) {
    throw new ShiftError("INVALID_INPUT");
  }

  // Keep counts and money consistent if a payment finalizes during this read.
  return db.$transaction(async (tx) => {
    const shift = await tx.shift.findUniqueOrThrow({
      where: { id: shiftId },
      select: { id: true, openedAt: true, closedAt: true, openingCash: true },
    });
    const orders = await tx.order.groupBy({
      by: ["status"], where: { shiftId: shift.id }, _count: { _all: true },
    });
    const payments = await tx.payment.groupBy({
      by: ["method"],
      where: { status: "SUCCEEDED", order: { shiftId: shift.id, status: "PAID" } },
      _sum: { amount: true },
    });
    const cashSales = payments.find((payment) => payment.method === "CASH")?._sum.amount ?? 0;
    const edcSales = payments.find((payment) => payment.method === "BCA_EDC")?._sum.amount ?? 0;

    return {
      shiftId: shift.id,
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
      totalOrders: orders.reduce((total, order) => total + order._count._all, 0),
      paidOrders: orders.find((order) => order.status === "PAID")?._count._all ?? 0,
      cancelledOrders: orders.find((order) => order.status === "CANCELLED")?._count._all ?? 0,
      grossSales: payments.reduce((total, payment) => total + (payment._sum.amount ?? 0), 0),
      cashSales,
      edcSales,
      expectedCash: calculateExpectedCash(shift.openingCash, cashSales),
    };
  }, { isolationLevel: "RepeatableRead" });
}
