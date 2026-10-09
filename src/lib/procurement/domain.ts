import type { ProcurementStatus, UserRole } from "../../generated/prisma/client";
import { businessDateRange } from "../reports/domain";

export class ProcurementError extends Error {}
export const categories = ["FURNITURE", "COFFEE_EQUIPMENT", "BAR_TOOLS", "ELECTRONICS", "FIXTURE", "OTHER"] as const;
export const priorities = ["NORMAL", "IMPORTANT", "URGENT"] as const;
export const statuses = ["DRAFT", "WAITING_APPROVAL", "APPROVED", "REJECTED", "ORDERED", "RECEIVED", "CANCELLED"] as const;
export const operations = ["CREATE", "EDIT", "SUBMIT", "APPROVE", "REJECT", "ORDER", "RECEIVE", "CANCEL"] as const;
export type Operation = typeof operations[number];
const fail = (message = "Data pengadaan tidak valid."): never => { throw new ProcurementError(message); };
export function object(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) return fail();
  return input as Record<string, unknown>;
}
export function text(value: unknown, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return fail();
  return value.trim();
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 2147483647) return fail("Gunakan bilangan bulat dalam batas 2147483647.");
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return fail();
  return value.toLowerCase();
}
export function total(quantity: number, price: number): number {
  const amount = BigInt(integer(quantity, 1)) * BigInt(integer(price));
  if (amount > BigInt(2147483647)) return fail("Total melampaui batas 2147483647 rupiah.");
  return Number(amount);
}
export function draftInput(input: unknown) {
  const r = object(input, ["itemName", "category", "quantity", "unit", "estimatedUnitPrice", "vendor", "productUrl", "neededDate", "priority", "reason", "notes"]);
  const category = categories.find(c => c === r.category) ?? fail();
  const priority = priorities.find(p => p === r.priority) ?? fail();
  const quantity = integer(r.quantity, 1), estimatedUnitPrice = integer(r.estimatedUnitPrice);
  const productUrl = text(r.productUrl, 2000, true);
  if (productUrl) {
    try { const url = new URL(productUrl); if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) fail("URL harus HTTP/HTTPS tanpa kredensial."); }
    catch { fail("URL produk tidak valid."); }
  }
  const date = text(r.neededDate, 10, true);
  if (date) { try { businessDateRange(date); } catch { fail("Tanggal tidak valid."); } }
  return { itemName: text(r.itemName, 200)!, category, quantity, unit: text(r.unit, 30)!, estimatedUnitPrice,
    estimatedTotal: total(quantity, estimatedUnitPrice), vendor: text(r.vendor, 200, true), productUrl,
    neededDate: date ? new Date(`${date}T00:00:00Z`) : null, priority, reason: text(r.reason, 2000)!, notes: text(r.notes, 2000, true) };
}
export function mutationInput(input: unknown) {
  const raw = object(input, ["id", "key", "revision", "operation", "data", "note", "actualUnitPrice"]);
  const operation = operations.find(o => o === raw.operation) ?? fail();
  const keys = ["id", "key", "revision", "operation", ...(["CREATE", "EDIT"].includes(operation) ? ["data"] : ["note"]), ...(operation === "ORDER" ? ["actualUnitPrice"] : [])];
  object(raw, keys);
  const revision = integer(raw.revision);
  if (revision === 2147483647 || (operation === "CREATE" ? revision !== 0 : revision < 1)) fail();
  return { id: uuid(raw.id), key: uuid(raw.key), revision, operation,
    data: operation === "CREATE" || operation === "EDIT" ? draftInput(raw.data) : null,
    note: text(raw.note, 2000, operation !== "REJECT" && operation !== "CANCEL"),
    actualUnitPrice: operation === "ORDER" && raw.actualUnitPrice !== undefined && raw.actualUnitPrice !== null ? integer(raw.actualUnitPrice) : null };
}
export function transition(role: UserRole, operation: Operation, status: ProcurementStatus | null, ownRequest = false): ProcurementStatus {
  const approval = operation === "APPROVE" || operation === "REJECT";
  if (role !== (approval ? "FINANCE" : "PROCUREMENT") || (approval && ownRequest)) return fail("Akses ditolak.");
  if (operation === "CREATE" && status === null) return "DRAFT";
  if (operation === "EDIT" && status === "DRAFT") return "DRAFT";
  if (operation === "SUBMIT" && status === "DRAFT") return "WAITING_APPROVAL";
  if (operation === "APPROVE" && status === "WAITING_APPROVAL") return "APPROVED";
  if (operation === "REJECT" && status === "WAITING_APPROVAL") return "REJECTED";
  if (operation === "ORDER" && status === "APPROVED") return "ORDERED";
  if (operation === "RECEIVE" && status === "ORDERED") return "RECEIVED";
  if (operation === "CANCEL" && status && ["DRAFT", "WAITING_APPROVAL", "APPROVED"].includes(status)) return "CANCELLED";
  return fail("Perubahan status tidak valid. Muat ulang permintaan.");
}
