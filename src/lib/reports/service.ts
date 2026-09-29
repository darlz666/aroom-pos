import "server-only";
import type { PrismaClient, PaymentMethod } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { getShiftCashSettlement } from "../shifts/settlement";
import { financials, type AdjustmentItem } from "./adjustment-domain";
import { businessDateRange, ReportError } from "./domain";

export type ReportTransaction = {
  orderId: string;
  revision: number;
  items: AdjustmentItem[];
  channelFee: number;
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
  totalDeductions: number;
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
  if (!actor.id || !["ADMIN", "CASHIER", "FINANCE"].includes(actor.role)) throw new ReportError("FORBIDDEN");
  const { businessDate, start, end } = businessDateRange(input);
  try {
    return await db.$transaction(async tx => {
      // Candidate query includes adjusted dates even when the original payment was
      // on another day. Only the latest revision determines final membership.
      const paidPayments = await tx.payment.findMany({
        where: { status: "SUCCEEDED", order: { status: "PAID", transactionVoid: null }, OR: [
          { succeededAt: { gte: start, lt: end }, order: { adjustments: { none: {} } } },
          { order: { adjustments: { some: { effectivePaidAt: { gte: start, lt: end } } } } },
        ] },
        orderBy: [{ succeededAt: "desc" }, { id: "desc" }],
        select: {
          id: true, orderId: true, method: true, amount: true, succeededAt: true,
          order: { select: { orderNumber: true, items: {
            orderBy: { id: "asc" }, select: { productNameSnapshot: true, quantity: true, unitPriceSnapshot: true },
          }, adjustments: { orderBy: { revision: "desc" }, take: 1, include: { items: { orderBy: { position: "asc" } } } } } },
        },
      });
      const totals = { paidSales: 0, paidOrderCount: 0, cashTotal: 0, edcTotal: 0, qrisTotal: 0 };
      const transactions: ReportTransaction[] = [];
      for (const payment of paidPayments) {
        if (!payment.succeededAt) throw new ReportError("UNAVAILABLE");
        const adjustment = payment.order.adjustments[0];
        const paidAt = adjustment?.effectivePaidAt ?? payment.succeededAt;
        if (paidAt < start || paidAt >= end) continue;
        const items: AdjustmentItem[] = adjustment ? adjustment.items.map(item => ({
          productName: item.productName, quantity: item.quantity, unitSellingPrice: item.unitSellingPrice, unitHpp: item.unitHpp,
        })) : payment.order.items.map(item => ({ productName: item.productNameSnapshot,
          quantity: item.quantity, unitSellingPrice: item.unitPriceSnapshot, unitHpp: null }));
        const originalRevenue = add(0, payment.amount);
        const amounts = adjustment ? financials(items, adjustment.channelFee) : {
          quantity: items.reduce((sum, item) => add(sum, item.quantity), 0), sellingPrice: originalRevenue,
          totalRevenue: originalRevenue, hpp: null, channelFee: 0, totalDeductions: 0,
          grossProfit: null, netRevenue: null, effectiveSales: originalRevenue,
        };
        totals.paidSales = add(totals.paidSales, amounts.effectiveSales);
        totals.paidOrderCount = add(totals.paidOrderCount, 1);
        const key = { CASH: "cashTotal", BCA_EDC: "edcTotal", MIDTRANS_QRIS: "qrisTotal" }[payment.method] as "cashTotal" | "edcTotal" | "qrisTotal";
        totals[key] = add(totals[key], amounts.effectiveSales);
        transactions.push({ orderId: payment.orderId, orderNumber: adjustment?.orderNumber ?? payment.order.orderNumber,
          revision: adjustment?.revision ?? 0, items, paidAt: paidAt.toISOString(), customerLabel: null,
          productsLabel: items.map(item => `${item.productName} x${item.quantity}`).join(", "),
          paymentMethod: payment.method, quantity: amounts.quantity, sellingPrice: amounts.sellingPrice,
          totalRevenue: amounts.totalRevenue, hpp: amounts.hpp, channelFee: amounts.channelFee,
          totalDeductions: amounts.totalDeductions, grossProfit: amounts.grossProfit, netRevenue: amounts.netRevenue,
          voucherDiscount: 0, posPromo: 0, receivable: 0, adsCost: 0,
        });
      }
      transactions.sort((a, b) => b.paidAt.localeCompare(a.paidAt) || b.orderId.localeCompare(a.orderId));
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
