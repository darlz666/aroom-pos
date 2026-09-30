import { businessDateRange, jakartaBusinessDate } from "../reports/domain";

export class FinanceError extends Error {}

export const categories = ["Gaji", "Sewa", "Listrik & Air", "Internet", "Maintenance", "Kebersihan", "Marketing", "Transport Operasional", "Lainnya"] as const;
export type PeriodInput = { type: "DAY" | "MONTH" | "YEAR" | "LIFETIME"; value?: string };
export function periodRange(input: unknown, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FinanceError("Periode tidak valid.");
  const { type, value } = input as PeriodInput;
  if (Object.keys(input).some(k => !["type", "value"].includes(k))) throw new FinanceError("Periode tidak valid.");
  if (type === "LIFETIME") {
    if (value !== undefined && value !== "") throw new FinanceError("Lifetime tidak memiliki tanggal.");
    return { type, value: "", start: undefined, end: now };
  }
  if (typeof value !== "string") throw new FinanceError("Pilih periode.");
  if (type === "DAY") return { type, value, ...businessDateRange(value) };
  if ((type === "MONTH" && !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) ||
      (type === "YEAR" && !/^[1-9]\d{3}$/.test(value)) || !["MONTH", "YEAR"].includes(type)) throw new FinanceError("Periode tidak valid.");
  const date = `${value}${type === "YEAR" ? "-01" : ""}-01`;
  const start = businessDateRange(date).start;
  const calendar = new Date(`${date}T00:00:00Z`);
  if (type === "MONTH") calendar.setUTCMonth(calendar.getUTCMonth() + 1);
  else calendar.setUTCFullYear(calendar.getUTCFullYear() + 1);
  return { type, value, start, end: new Date(calendar.getTime() - 7 * 3600000) };
}
export function defaultPeriod(): PeriodInput { return { type: "MONTH", value: jakartaBusinessDate().slice(0, 7) }; }
export function safeMoney(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new FinanceError("Jumlah melampaui batas aman.");
  return Number(value);
}
export function sumMoney(values: number[]): number {
  return safeMoney(values.reduce((sum, n) => {
    if (!Number.isSafeInteger(n)) throw new FinanceError("Jumlah tidak valid.");
    return sum + BigInt(n);
  }, BigInt(0)));
}
export function expenseInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FinanceError("Pengeluaran tidak valid.");
  const r = input as Record<string, unknown>;
  if (Object.keys(r).some(k => !["id", "key", "revision", "operation", "date", "amount", "category", "description", "note"].includes(k))) throw new FinanceError("Data tidak valid.");
  const uuid = (v: unknown) => { if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw new FinanceError("Identitas tidak valid."); return v; };
  const operation = r.operation;
  if (!["CREATE", "EDIT", "DELETE"].includes(String(operation))) throw new FinanceError("Operasi tidak valid.");
  const key = uuid(r.key), id = uuid(r.id);
  if (!Number.isInteger(r.revision) || Number(r.revision) < 0 || Number(r.revision) >= 2147483647) throw new FinanceError("Revisi tidak valid.");
  const base = { key, id, revision: Number(r.revision), operation: operation as "CREATE" | "EDIT" | "DELETE" };
  if (operation === "DELETE") return { ...base, data: null };
  const text = (v: unknown, max: number, optional = false) => { if (optional && (v === undefined || v === "")) return null; if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new FinanceError("Teks tidak valid."); return v.trim(); };
  if (!categories.includes(r.category as typeof categories[number])) throw new FinanceError("Kategori tidak valid.");
  if (!Number.isSafeInteger(r.amount) || Number(r.amount) <= 0 || Number(r.amount) > 2147483647) throw new FinanceError("Nominal harus rupiah bulat positif, maksimal 2147483647.");
  return { ...base, data: { occurredAt: businessDateRange(r.date).start, amount: Number(r.amount), category: String(r.category), description: text(r.description, 200)!, note: text(r.note, 1000, true) } };
}
