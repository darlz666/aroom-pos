"use server";
import { unstable_rethrow } from "next/navigation";
import { requireFinanceManager, requireRole } from "../auth/authorization";
import { prisma } from "../db";
import { getFinanceReport, getFinanceHistory, listExpenses, saveExpense } from "./service";
import { deleteFinanceHistory } from "./history-deletion";
import { FinanceError } from "./domain";

async function attempt<T>(work: () => Promise<T>) {
  try { return { success: true, data: await work() } as const; }
  catch (error) { unstable_rethrow(error); return { success: false, error: error instanceof FinanceError ? error.message : "Data belum dapat diproses. Periksa input/koneksi; muat ulang bila data telah berubah.", retryable: !(error instanceof FinanceError) } as const; }
}
export async function financeReportAction(input: unknown) { return attempt(async () => getFinanceReport(prisma, await requireFinanceManager(), input)); }
export async function financeHistoryAction(input: unknown, filters: unknown) { return attempt(async () => getFinanceHistory(prisma, await requireFinanceManager(), input, filters)); }
export async function expenseListAction(input: unknown, search = "", category = "", page = 1) { return attempt(async () => listExpenses(prisma, await requireFinanceManager(), input, search, category, page)); }
export async function expenseSaveAction(input: unknown) { return attempt(async () => saveExpense(prisma, await requireFinanceManager(), input)); }

export async function financeHistoryDeleteAction(input: unknown) { return attempt(async () => deleteFinanceHistory(prisma, await requireRole("ADMIN"), input)); }
