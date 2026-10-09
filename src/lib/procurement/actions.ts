"use server";
import { unstable_rethrow } from "next/navigation";
import { requireProcurementApprover, requireProcurementReader, requireProcurementWriter } from "../auth/authorization";
import { prisma } from "../db";
import { mutationInput, ProcurementError } from "./domain";
import { readProcurement, saveProcurement } from "./service";

async function attempt<T>(work: () => Promise<T>) {
  try { return { success: true, data: await work() } as const; }
  catch (error) {
    unstable_rethrow(error);
    return { success: false, error: error instanceof ProcurementError ? error.message : "Pengadaan belum dapat diproses. Periksa koneksi lalu coba lagi dengan permintaan yang sama.", retryable: !(error instanceof ProcurementError) } as const;
  }
}
export async function procurementReadAction(input: unknown) {
  return attempt(async () => readProcurement(prisma, await requireProcurementReader(), input));
}
export async function procurementWriteAction(input: unknown) {
  return attempt(async () => {
    const actor = await requireProcurementWriter();
    const request = mutationInput(input);
    if (["APPROVE", "REJECT"].includes(request.operation)) throw new ProcurementError("Akses ditolak.");
    return saveProcurement(prisma, actor, input);
  });
}
export async function procurementDecisionAction(input: unknown) {
  return attempt(async () => {
    const actor = await requireProcurementApprover();
    if (!["APPROVE", "REJECT"].includes(mutationInput(input).operation)) throw new ProcurementError("Akses ditolak.");
    return saveProcurement(prisma, actor, input);
  });
}
