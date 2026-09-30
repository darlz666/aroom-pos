import type { ReportTransaction } from "../reports/service";
import { categories, FinanceError, sumMoney } from "./domain";

export function expenseCategories(expenses: { category: string; amount: number }[]) {
  const total = sumMoney(expenses.map(row => row.amount));
  let offset = 0;
  return categories.map(category => {
    const amount = sumMoney(expenses.filter(row => row.category === category).map(row => row.amount));
    const percentage = total === 0 ? 0 : Number((BigInt(amount) * BigInt(10000) + BigInt(total) / BigInt(2)) / BigInt(total)) / 100;
    const start = offset;
    offset += total === 0 ? 0 : amount / total * 100;
    return { category, amount, percentage, start, end: offset };
  }).filter(row => row.amount > 0);
}

export function historyFilter(input: unknown) {
  const r = input as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(key => !["type", "method", "search", "page"].includes(key)) ||
    !["ALL", "INCOME", "EXPENSE"].includes(String(r.type)) || !["ALL", "CASH", "BCA_EDC", "MIDTRANS_QRIS"].includes(String(r.method)) ||
    typeof r.search !== "string" || r.search.length > 200 || !Number.isSafeInteger(r.page) || Number(r.page) < 1 || Number(r.page) > 100000) throw new FinanceError("Filter riwayat tidak valid.");
  return { type: String(r.type), method: String(r.method), search: r.search.trim().toLocaleLowerCase("id-ID"), page: Number(r.page) };
}
export function historyPage(sales: ReportTransaction[], expenses: { revision: number; id: string; occurredAt: Date; category: string; description: string; amount: number }[], filter: ReturnType<typeof historyFilter>) {
  const methods = { CASH: "Tunai", BCA_EDC: "BCA EDC", MIDTRANS_QRIS: "QRIS" };
  const income = filter.type === "EXPENSE" ? [] : sales.filter(row => (filter.method === "ALL" || row.paymentMethod === filter.method) && row.orderNumber.toLocaleLowerCase("id-ID").includes(filter.search)).map(row => ({
    id: `sale-${row.orderId}`, referenceId: row.orderId, revision: row.revision, type: "INCOME" as const, date: row.paidAt, title: `Penjualan - ${row.quantity} produk`, description: `Pesanan: ${row.orderNumber}`, badge: methods[row.paymentMethod], amount: row.totalRevenue,
  }));
  const outgoing = filter.type === "INCOME" ? [] : expenses.filter(row => [row.description, row.category].some(value => value.toLocaleLowerCase("id-ID").includes(filter.search))).map(row => ({
    id: `expense-${row.id}`, referenceId: row.id, revision: row.revision, type: "EXPENSE" as const, date: row.occurredAt.toISOString(), title: row.category, description: row.description, badge: row.category, amount: row.amount,
  }));
  const rows = [...income, ...outgoing].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const pageSize = 10, total = rows.length, pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(filter.page, pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize };
}
