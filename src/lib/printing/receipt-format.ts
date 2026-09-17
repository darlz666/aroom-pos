import type { getReceipt } from "../orders/receipt";

/** Only populate this from the authenticated, paid-only getReceipt projection. */
export type Receipt = Awaited<ReturnType<typeof getReceipt>>;

/** Logical text layout, not printer bytes. The future bridge must fit this to
 * 58 mm paper and validate fonts/Unicode on hardware; 32 is not a device claim. */
export type PrintReceipt = Readonly<{ paperWidthMm: 58; columns: 32; text: string }>;
const columns = 32;
const rule = "-".repeat(columns);
const rupiah = (value: number) => `Rp${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;

function wrap(value: string): string[] {
  // User-entered names/references are text, never control sequences or new lines.
  let characters = Array.from(value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim());
  const lines: string[] = [];
  while (characters.length > columns) {
    const space = characters.slice(0, columns + 1).lastIndexOf(" ");
    const end = space > 0 ? space : columns;
    lines.push(characters.slice(0, end).join(""));
    characters = characters.slice(end);
    if (characters[0] === " ") characters.shift();
  }
  if (characters.length) lines.push(characters.join(""));
  return lines;
}

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
  const add = (text: string) => lines.push(...wrap(text));
  if (copy) lines.push("COPY");
  add(`Pesanan: ${receipt.orderNumber}`);
  add(jakartaDateTime(receipt.createdAt));
  add(`Kasir: ${receipt.cashier}`);
  lines.push(receipt.orderType === "DINE_IN" ? "Dine-in" : "Takeaway", rule);
  for (const item of receipt.items) {
    add(item.name);
    add(`${item.quantity} x ${rupiah(item.unitPrice)}`);
    add(`Jumlah: ${rupiah(item.lineTotal)}`);
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
