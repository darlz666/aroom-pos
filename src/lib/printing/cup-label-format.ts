import type { Receipt } from "./receipt-format";
import { wrapPrintText } from "./logical-text";

/** Logical label preview, not bytes or dimensions for an untested sticker printer. */
export type PrintCupLabel = Readonly<{
  kind: "cup-label";
  cupNumber: number;
  totalCups: number;
  text: string;
}>;

const sugar = { NORMAL: "NORMAL", LESS: "LESS", NO_SUGAR: "NO SUGAR" } as const;
const ice = { NORMAL: "NORMAL", LESS: "LESS", NO_ICE: "NO ICE" } as const;

/** Use the authorized paid snapshot only. Explicit saved cups identify beverages:
 * legacy items and food without cups produce no labels. No prices are calculated. */
export function formatCupLabels(receipt: Receipt, copy = false): readonly PrintCupLabel[] {
  const totalCups = receipt.items.reduce((total, item) => total + (item.cups?.length ?? 0), 0);
  const labels: PrintCupLabel[] = [];
  for (const item of receipt.items) {
    for (const cup of item.cups ?? []) {
      const cupNumber = labels.length + 1;
      const lines: string[] = ["AROOM Coffee Bar"];
      const add = (text: string) => lines.push(...wrapPrintText(text));
      if (copy) lines.push("COPY");
      add(`Pesanan: ${receipt.orderNumber}`);
      add(`Pelanggan: ${receipt.customerName || "-"}`);
      add(item.name);
      add(`Cup: ${cupNumber}/${totalCups}`);
      add(`Sugar: ${sugar[cup.sugar]}`);
      add(`Ice: ${ice[cup.ice]}`);
      add(`Size: ${cup.cup}`);
      if (item.notes) add(`Catatan item: ${item.notes}`);
      if (cup.notes) add(`Catatan: ${cup.notes}`);
      labels.push(Object.freeze({ kind: "cup-label", cupNumber, totalCups, text: lines.join("\n") + "\n" }));
    }
  }
  return Object.freeze(labels);
}
