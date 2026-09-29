import { businessDateRange } from "./domain";

export class AdjustmentError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "INVALID_INPUT" | "CONFLICT" | "VOIDED" | "UNAVAILABLE") { super(code); }
}
const invalid = (): never => { throw new AdjustmentError("INVALID_INPUT"); };
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return invalid();
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return invalid();
  const result = value.normalize("NFC").trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) return invalid();
  return result;
}
export function integer(value: unknown, min = 0): number {
  // Match PostgreSQL Int and the existing transaction money bounds.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 2147483647) return invalid();
  return value;
}
export type AdjustmentItem = { productName: string; quantity: number; unitSellingPrice: number; unitHpp: number | null };
export function financials(items: AdjustmentItem[], channelFee: number) {
  let selling = BigInt(0), cost = BigInt(0), quantity = BigInt(0);
  for (const item of items) {
    quantity += BigInt(integer(item.quantity, 1));
    selling += BigInt(item.quantity) * BigInt(integer(item.unitSellingPrice));
    if (item.unitHpp !== null) cost += BigInt(item.quantity) * BigInt(integer(item.unitHpp));
  }
  const sellingPrice = integer(Number(selling));
  const hpp = items.some(item => item.unitHpp === null) ? null : integer(Number(cost));
  integer(channelFee);
  if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
  const grossProfit = hpp === null ? null : sellingPrice - hpp;
  const netRevenue = grossProfit === null ? null : grossProfit - channelFee;
  return { quantity: Number(quantity), sellingPrice, totalRevenue: sellingPrice, hpp,
    channelFee, totalDeductions: channelFee, grossProfit, netRevenue,
    effectiveSales: sellingPrice };
}
function reason(value: unknown) { return value === undefined || value === null || (typeof value === "string" && !value.trim()) ? null : text(value, 500); }
export function adjustmentInput(value: unknown) {
  const raw = object(value, ["orderId", "expectedRevision", "idempotencyKey", "businessDate", "orderNumber", "channelFee", "reason", "items"]);
  let businessDate: string;
  try { businessDate = businessDateRange(raw.businessDate).businessDate; } catch { return invalid(); }
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) return invalid();
  const items = raw.items.map(value => {
    const item = object(value, ["productName", "quantity", "unitSellingPrice", "unitHpp"]);
    return { productName: text(item.productName, 200), quantity: integer(item.quantity, 1),
      unitSellingPrice: integer(item.unitSellingPrice), unitHpp: item.unitHpp === null ? null : integer(item.unitHpp) };
  });
  const channelFee = integer(raw.channelFee);
  financials(items, channelFee);
  return { orderId: id(raw.orderId), expectedRevision: integer(raw.expectedRevision), idempotencyKey: id(raw.idempotencyKey),
    businessDate, orderNumber: text(raw.orderNumber, 100), channelFee, reason: reason(raw.reason), items };
}
export function voidInput(value: unknown) {
  const raw = object(value, ["transactions", "businessDate", "reason"]);
  let businessDate: string;
  try { businessDate = businessDateRange(raw.businessDate).businessDate; } catch { return invalid(); }
  if (!Array.isArray(raw.transactions) || !raw.transactions.length || raw.transactions.length > 1000) return invalid();
  const byOrder = new Map<string, number>();
  for (const value of raw.transactions) {
    const item = object(value, ["orderId", "expectedRevision"]);
    const orderId = id(item.orderId), expectedRevision = integer(item.expectedRevision);
    const existing = byOrder.get(orderId);
    if (existing !== undefined && existing !== expectedRevision) return invalid();
    byOrder.set(orderId, expectedRevision);
  }
  const transactions = [...byOrder].map(([orderId, expectedRevision]) => ({ orderId, expectedRevision }))
    .sort((a, b) => a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);
  return { transactions, businessDate, reason: reason(raw.reason) };
}
/** Replace the Jakarta calendar date, retaining ORIGINAL payment time incl. ms. */
export function effectivePaidAt(businessDate: string, original: Date): Date {
  const { start } = businessDateRange(businessDate);
  const offset = ((original.getTime() + 7 * 3600000) % 86400000 + 86400000) % 86400000;
  return new Date(start.getTime() + offset);
}
