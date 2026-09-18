import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { getShiftCashSettlement } from "../shifts/settlement";
import { businessDateRange, ReportError } from "./domain";

function add(total: number, amount: number): number {
  const result = total + amount;
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(result)) {
    throw new ReportError("UNAVAILABLE");
  }
  return result;
}

/** Internal read-only API; actor must come from fresh server authentication. */
export async function getDailyReport(db: PrismaClient, actor: ShiftActor, input: unknown) {
  if (!actor.id || actor.role !== "ADMIN") throw new ReportError("FORBIDDEN");
  const { businessDate, start, end } = businessDateRange(input);
  try {
    return await db.$transaction(async tx => {
      // Aggregate Payment directly: no item/notification joins that multiply sales.
      // The database permits only one successful payment per order.
      const payments = await tx.payment.groupBy({
        by: ["method"],
        where: { status: "SUCCEEDED", succeededAt: { gte: start, lt: end }, order: { status: "PAID" } },
        _sum: { amount: true }, _count: { _all: true },
      });
      const totals = { paidSales: 0, paidOrderCount: 0, cashTotal: 0, edcTotal: 0, qrisTotal: 0 };
      for (const group of payments) {
        const amount = group._sum.amount ?? 0;
        totals.paidSales = add(totals.paidSales, amount);
        totals.paidOrderCount = add(totals.paidOrderCount, group._count._all);
        switch (group.method) {
          case "CASH": totals.cashTotal = amount; break;
          case "BCA_EDC": totals.edcTotal = amount; break;
          case "MIDTRANS_QRIS": totals.qrisTotal = amount; break;
        }
      }
      const shifts = await tx.shift.findMany({
        where: { openedAt: { lt: end }, OR: [{ closedAt: null }, { closedAt: { gte: start } }] },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        select: { id: true, status: true, openedAt: true, closedAt: true, openingCash: true,
          expectedCash: true, countedCash: true, variance: true, cashier: { select: { name: true } } },
      });
      const reconciliation = [];
      for (const shift of shifts) {
        if (shift.status === "CLOSED" &&
          (shift.expectedCash === null || shift.countedCash === null || shift.variance === null || shift.closedAt === null)) {
          throw new ReportError("UNAVAILABLE");
        }
        // Closed reconciliation is immutable historical evidence, never recomputed.
        const expectedCash = shift.status === "CLOSED" ? shift.expectedCash! :
          (await getShiftCashSettlement(tx, shift)).expectedCash;
        reconciliation.push({
          id: shift.id, status: shift.status, cashierName: shift.cashier.name,
          openedAt: shift.openedAt.toISOString(), closedAt: shift.closedAt?.toISOString() ?? null,
          openingCash: shift.openingCash, expectedCash,
          countedCash: shift.countedCash, variance: shift.variance,
        });
      }
      return { businessDate, ...totals, shifts: reconciliation };
    }, { isolationLevel: "RepeatableRead" });
  } catch {
    throw new ReportError("UNAVAILABLE");
  }
}

export type DailyReport = Awaited<ReturnType<typeof getDailyReport>>;
