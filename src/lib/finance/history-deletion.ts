import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";
import type { ShiftActor } from "../shifts/domain";
import { authorized, voidTransactionsInTransaction } from "../reports/adjustment-service";
import { id, integer, object } from "../reports/adjustment-domain";
import { businessDateRange } from "../reports/domain";
import { FinanceError } from "./domain";
import { saveExpenseInTransaction } from "./service";

export type HistoryDeletion = { key: string; rows: { type: "INCOME" | "EXPENSE"; id: string; revision: number; businessDate: string }[] };

export function deletionInput(input: unknown): HistoryDeletion {
  const raw = object(input, ["key", "rows"]);
  const key = id(raw.key);
  if (!Array.isArray(raw.rows) || !raw.rows.length || raw.rows.length > 100) throw new FinanceError("Pilih 1–100 transaksi.");
  const rows = new Map<string, HistoryDeletion["rows"][number]>();
  for (const value of raw.rows) {
    const r = object(value, ["type", "id", "revision", "businessDate"]);
    if (r.type !== "INCOME" && r.type !== "EXPENSE") throw new FinanceError("Jenis transaksi tidak valid.");
    const row: HistoryDeletion["rows"][number] = { type: r.type, id: id(r.id), revision: integer(r.revision), businessDate: businessDateRange(r.businessDate).businessDate };
    const identity = `${row.type}:${row.id}`, previous = rows.get(identity);
    if (previous && (previous.revision !== row.revision || previous.businessDate !== row.businessDate)) throw new FinanceError("Pilihan memiliki revisi yang berbeda.");
    rows.set(identity, row);
  }
  return { key, rows: [...rows.values()].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) };
}

/** One ADMIN lock and one transaction for the complete mixed selection. */
export async function deleteFinanceHistory(db: PrismaClient, actor: ShiftActor, input: unknown) {
  return authorized(db, actor, async tx => {
    const request = deletionInput(input);
    for (const row of request.rows) {
      if (row.type === "INCOME") {
        await voidTransactionsInTransaction(tx, actor, { businessDate: row.businessDate, transactions: [{ orderId: row.id, expectedRevision: row.revision }] });
      } else {
        // A stable per-expense UUID lets the existing actor-bound receipt handle lost responses.
        const hash = createHash("sha256").update(`${request.key}:${row.id}`).digest("hex");
        const key = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        await saveExpenseInTransaction(tx, actor, { operation: "DELETE", id: row.id, revision: row.revision, key });
      }
    }
    return { count: request.rows.length };
  });
}
