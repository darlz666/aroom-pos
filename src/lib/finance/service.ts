import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { readEffectiveSales, type ReportTransaction } from "../reports/service";
import { jakartaBusinessDate } from "../reports/domain";
import { costMicros, quantityThousandths, roundHalfUp } from "../inventory/costing";
import { categories, FinanceError, expenseInput, periodRange, safeMoney, sumMoney } from "./domain";
import { expenseCategories, historyFilter, historyPage } from "./presentation";

export async function authorizeFinance(db: PrismaClient, actor: ShiftActor) {
  if (!actor?.id || !["ADMIN", "FINANCE"].includes(actor.role)) throw new FinanceError("Akses ditolak.");
  const current = await db.user.findFirst({ where: { id: actor.id, active: true, role: { in: ["ADMIN", "FINANCE"] } }, select: { id: true } });
  if (!current) throw new FinanceError("Akses ditolak.");
}
export function summarize(sales: ReportTransaction[], expenses: { amount: number }[]) {
  const total = (key: "totalRevenue" | "channelFee" | "adsCost") => sumMoney(sales.map(s => s[key]));
  const known = (key: "hpp" | "grossProfit" | "netRevenue") => sales.some(s => s[key] === null) ? null : sumMoney(sales.map(s => s[key]!));
  const operatingExpenses = sumMoney(expenses.map(e => e.amount));
  const salesNetRevenue = known("netRevenue");
  return { paidSales: total("totalRevenue"), paidOrderCount: sales.length,
    cashTotal: sumMoney(sales.filter(s => s.paymentMethod === "CASH").map(s => s.totalRevenue)),
    edcTotal: sumMoney(sales.filter(s => s.paymentMethod === "BCA_EDC").map(s => s.totalRevenue)),
    qrisTotal: sumMoney(sales.filter(s => s.paymentMethod === "MIDTRANS_QRIS").map(s => s.totalRevenue)),
    hpp: known("hpp"), grossProfit: known("grossProfit"), salesDeductions: sumMoney([total("channelFee"), total("adsCost")]),
    operatingExpenses, salesNetRevenue, netIncome: salesNetRevenue === null ? null : sumMoney([salesNetRevenue, -operatingExpenses]) };
}
export function inventoryValue(rows: { currentStock: { toString(): string }; weightedAverageUnitCostMicros: bigint | null }[]) {
  let amount = BigInt(0), missing = 0;
  for (const row of rows) {
    const quantity = quantityThousandths(row.currentStock.toString());
    if (quantity === BigInt(0)) continue;
    if (row.weightedAverageUnitCostMicros === null) { missing++; continue; }
    amount += roundHalfUp(quantity * costMicros(row.weightedAverageUnitCostMicros), BigInt(1000000000));
  }
  return { amount: missing ? null : safeMoney(amount), missing };
}
export async function getFinanceReport(db: PrismaClient, actor: ShiftActor, input: unknown) {
  await authorizeFinance(db, actor);
  const now = new Date(), period = periodRange(input, now);
  return db.$transaction(async tx => {
    const sales = await readEffectiveSales(tx, period.start, period.end);
    const expenses = await tx.financeExpense.findMany({ where: { deletedAt: null, occurredAt: { gte: period.start, lt: period.end } }, select: { occurredAt: true, amount: true, category: true } });
    const inventory = inventoryValue(await tx.ingredient.findMany({ select: { currentStock: true, weightedAverageUnitCostMicros: true } }));
    const keys: string[] = [];
    if (period.type === "MONTH") {
      for (let d = period.start.getTime(); d < period.end.getTime(); d += 86400000) keys.push(jakartaBusinessDate(new Date(d)));
    } else if (period.type === "YEAR") {
      for (let m = 1; m <= 12; m++) keys.push(`${period.value}-${String(m).padStart(2, "0")}`);
    }
    const groupedSales = new Map<string, ReportTransaction[]>();
    const groupedExpenses = new Map<string, { amount: number }[]>();
    const keyFor = (date: Date) => jakartaBusinessDate(date).slice(0, period.type === "YEAR" ? 7 : 10);
    let earliest: string | null = null;
    for (const sale of sales.transactions) {
      if (earliest === null || sale.paidAt < earliest) earliest = sale.paidAt;
      if (keys.length) { const key = keyFor(new Date(sale.paidAt)); const rows = groupedSales.get(key) ?? []; rows.push(sale); groupedSales.set(key, rows); }
    }
    for (const expense of expenses) {
      const date = expense.occurredAt.toISOString();
      if (earliest === null || date < earliest) earliest = date;
      if (keys.length) { const key = keyFor(expense.occurredAt); const rows = groupedExpenses.get(key) ?? []; rows.push(expense); groupedExpenses.set(key, rows); }
    }
    const breakdown = keys.map(key => ({ key, ...summarize(groupedSales.get(key) ?? [], groupedExpenses.get(key) ?? []) }));
    return { period: { type: period.type, value: period.value, start: period.type === "LIFETIME" ? earliest : period.start.toISOString(), end: period.end.toISOString() },
      summary: summarize(sales.transactions, expenses), breakdown, expenseCategories: expenseCategories(expenses), inventory: { ...inventory, asOf: now.toISOString() } };
  }, { isolationLevel: "RepeatableRead" });
}
export async function getFinanceHistory(db: PrismaClient, actor: ShiftActor, input: unknown, filters: unknown) {
  await authorizeFinance(db, actor);
  const period = periodRange(input), filter = historyFilter(filters);
  return db.$transaction(async tx => {
    const sales = filter.type === "EXPENSE" ? [] : (await readEffectiveSales(tx, period.start, period.end)).transactions;
    const expenses = filter.type === "INCOME" ? [] : await tx.financeExpense.findMany({
      where: { deletedAt: null, occurredAt: { gte: period.start, lt: period.end } },
      select: { id: true, occurredAt: true, category: true, description: true, amount: true },
    });
    return historyPage(sales, expenses, filter);
  }, { isolationLevel: "RepeatableRead" });
}
export async function saveExpense(db: PrismaClient, actor: ShiftActor, input: unknown) {
  if (!actor?.id || !["ADMIN", "FINANCE"].includes(actor.role)) throw new FinanceError("Akses ditolak.");
  const request = expenseInput(input);
  const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: actor.id, ...request })).digest("hex");
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id}::uuid FOR SHARE`;
    const user = await tx.user.findFirst({ where: { id: actor.id, active: true, role: { in: ["ADMIN", "FINANCE"] } }, select: { id: true } });
    if (!user) throw new FinanceError("Akses ditolak.");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.key}, 926))`;
    const replay = await tx.financeExpenseRequest.findUnique({ where: { key: request.key } });
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new FinanceError("Permintaan berbeda menggunakan kunci yang sama.");
      return { id: replay.expenseId, revision: replay.revision };
    }
    await tx.$queryRaw`SELECT id FROM "FinanceExpense" WHERE id = ${request.id}::uuid FOR UPDATE`;
    const before = await tx.financeExpense.findUnique({ where: { id: request.id } });
    if (request.operation === "CREATE" ? before || request.revision !== 0 : !before || before.deletedAt || before.revision !== request.revision) throw new FinanceError("Data telah berubah. Muat ulang pengeluaran.");
    const saved = request.operation === "CREATE" ? await tx.financeExpense.create({ data: { id: request.id, ...request.data!, createdBy: actor.id } }) :
      await tx.financeExpense.update({ where: { id: request.id }, data: { ...(request.operation === "DELETE" ? { deletedAt: new Date() } : request.data!), revision: { increment: 1 } } });
    await tx.auditLog.create({ data: { actorId: actor.id, action: `FINANCE_EXPENSE_${request.operation}`, entityType: "FinanceExpense", entityId: saved.id,
      details: JSON.parse(JSON.stringify({ before, after: saved })) } });
    await tx.financeExpenseRequest.create({ data: { key: request.key, fingerprint, expenseId: saved.id, revision: saved.revision } });
    return { id: saved.id, revision: saved.revision };
  });
}
export async function listExpenses(db: PrismaClient, actor: ShiftActor, input: unknown, search = "", category = "", page = 1) {
  await authorizeFinance(db, actor);
  const period = periodRange(input);
  if (typeof search !== "string" || search.length > 200 || typeof category !== "string" || (category !== "" && !categories.includes(category as typeof categories[number])) || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new FinanceError("Filter tidak valid.");
  const rows = await db.financeExpense.findMany({ where: { deletedAt: null, occurredAt: { gte: period.start, lt: period.end }, ...(category ? { category } : {}),
    OR: [{ description: { contains: search, mode: "insensitive" } }, { category: { contains: search, mode: "insensitive" } }] },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 51 });
  return { hasMore: rows.length > 50, rows: rows.slice(0, 50).map(r => ({ ...r, occurredAt: jakartaBusinessDate(r.occurredAt), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), deletedAt: null })) };
}
