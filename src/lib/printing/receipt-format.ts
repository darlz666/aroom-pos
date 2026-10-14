import type { getReceipt } from "../orders/receipt";
import { wrapPrintText } from "./logical-text";

/** Only populate this from the authenticated, paid-only getReceipt projection. */
export type Receipt = Awaited<ReturnType<typeof getReceipt>>;

/** Logical text layout, not printer bytes. The future bridge must fit this to
 * 58 mm paper and validate fonts/Unicode on hardware; 32 is not a device claim. */
export type PrintReceipt = Readonly<{ paperWidthMm: 58; columns: 32; text: string }>;
const columns = 32;
const rule = "-".repeat(columns);
const rupiah = (value: number) => `Rp${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

function jakartaDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")} WIB`;
}

/** Formats saved values only: no totals, prices or change are recalculated. */
export function formatReceipt(receipt: Receipt, copy = false): PrintReceipt {
  const lines: string[] = ["AROOM Coffee Bar"];
  const add = (text: string) => lines.push(...wrapPrintText(text, columns));
  if (copy) lines.push("COPY");
  add(`Pesanan: ${receipt.orderNumber}`);
  add(jakartaDateTime(receipt.createdAt));
  add(`Kasir: ${receipt.cashier}`);
  add(`Pelanggan: ${receipt.customerName || "-"}`);
  lines.push(receipt.orderType === "DINE_IN" ? "Dine-in" : "Takeaway", rule);
  for (const item of receipt.items) {
    add(item.name);
    add(`${item.quantity} x ${rupiah(item.unitPrice)}`);
    add(`Jumlah: ${rupiah(item.lineTotal)}`);
    if (item.notes) add(`Catatan: ${item.notes}`);
  }
  lines.push(rule);
  add(`TOTAL: ${rupiah(receipt.total)}`);
  const { payment } = receipt;
  add(`Pembayaran: ${payment.method === "CASH" ? "Tunai" : payment.method === "BCA_EDC" ? "BCA EDC" : "QRIS"}`);
  if (payment.method === "CASH") {
    if (payment.cashReceived !== null) add(`Uang diterima: ${rupiah(payment.cashReceived)}`);
    if (payment.changeAmount !== null) add(`Kembalian: ${rupiah(payment.changeAmount)}`);
  }
  if (payment.method === "BCA_EDC" && payment.edcReference) add(`Referensi EDC: ${payment.edcReference}`);
  return Object.freeze({ paperWidthMm: 58, columns, text: lines.join("\n") + "\n" });
}
