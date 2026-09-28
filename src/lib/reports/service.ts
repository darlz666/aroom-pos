import "server-only";
import type { Prisma, PrismaClient, PaymentMethod } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { getShiftCashSettlement } from "../shifts/settlement";
import { businessDateRange, ReportError } from "./domain";

export type ReportTransaction = {
  orderId: string;
  orderNumber: string;
  paidAt: string;
  customerLabel: string | null;
  productsLabel: string;
  quantity: number;
  paymentMethod: PaymentMethod;
  sellingPrice: number;
  totalRevenue: number;
  voucherDiscount: number;
  posPromo: number;
  receivable: number;
  hpp: number | null;
  adsCost: number;
  totalDiscount: number;
  grossProfit: number | null;
  netRevenue: number | null;
};

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
      const paidWhere = {
        status: "SUCCEEDED", succeededAt: { gte: start, lt: end }, order: { status: "PAID" },
      } satisfies Prisma.PaymentWhereInput;
      // Aggregate Payment directly: no item/notification joins that multiply sales.
      // The database permits only one successful payment per order.
      const payments = await tx.payment.groupBy({
        by: ["method"],
        where: paidWhere,
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
      const paidPayments = await tx.payment.findMany({
        where: paidWhere,
        orderBy: [{ succeededAt: "desc" }, { id: "desc" }],
        select: {
          orderId: true, method: true, amount: true, succeededAt: true,
          order: { select: { orderNumber: true, items: {
            orderBy: { id: "asc" }, select: { productNameSnapshot: true, quantity: true },
          } } },
        },
      });
      const transactions: ReportTransaction[] = paidPayments.map(payment => {
        if (!payment.succeededAt) throw new ReportError("UNAVAILABLE");
        const totalRevenue = add(0, payment.amount);
        const quantity = payment.order.items.reduce((sum, item) => add(sum, item.quantity), 0);
        // Placeholders only: customer/table, discounts, receivables and ads are not persisted.
        const voucherDiscount = 0;
        const posPromo = 0;
        return {
          orderId: payment.orderId, orderNumber: payment.order.orderNumber,
          paidAt: payment.succeededAt.toISOString(), customerLabel: null,
          productsLabel: payment.order.items.map(item => `${item.productNameSnapshot} x${item.quantity}`).join(", "),
          quantity, paymentMethod: payment.method,
          // No pre-discount price exists yet; both columns use the saved successful payment amount.
          sellingPrice: totalRevenue, totalRevenue,
          voucherDiscount, posPromo, receivable: 0, adsCost: 0,
          totalDiscount: add(voucherDiscount, posPromo),
          // SALE_CONSUMPTION records quantities, not historical WAC/costs. Current
          // recipes/WAC and purchase prices cannot establish HPP at payment time.
          // Profit and net revenue remain unavailable until historical HPP exists.
          hpp: null, grossProfit: null, netRevenue: null,
        };
      });
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
      return { businessDate, ...totals, shifts: reconciliation, transactions };
    }, { isolationLevel: "RepeatableRead" });
  } catch {
    throw new ReportError("UNAVAILABLE");
  }
}

export type DailyReport = Awaited<ReturnType<typeof getDailyReport>>;
