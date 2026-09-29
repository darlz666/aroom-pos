"use server";
import { unstable_rethrow } from "next/navigation";
import { requireRole } from "../auth/authorization";
import { prisma } from "../db";
import { AdjustmentError } from "./adjustment-domain";
import { adjustTransaction, voidTransactions } from "./adjustment-service";

const messages = {
  FORBIDDEN: "Hanya admin aktif yang dapat mengubah laporan.",
  INVALID_INPUT: "Periksa tanggal, nama, jumlah, harga, HPP dan potongan. Potongan tidak boleh melebihi penjualan.",
  CONFLICT: "Transaksi telah berubah. Muat ulang laporan sebelum melanjutkan.",
  VOIDED: "Transaksi sudah dihapus dari laporan aktif.",
  UNAVAILABLE: "Hasil belum dapat dipastikan. Periksa koneksi dan periksa kembali permintaan yang sama.",
};
function failure(error: unknown) {
  unstable_rethrow(error);
  const code = error instanceof AdjustmentError ? error.code : "UNAVAILABLE";
  return { success: false, code, error: messages[code] } as const;
}
export async function adjustTransactionAction(input: unknown) {
  try { return { success: true, result: await adjustTransaction(prisma, await requireRole("ADMIN"), input) } as const; }
  catch (error) { return failure(error); }
}
export async function voidTransactionsAction(input: unknown) {
  try { return { success: true, result: await voidTransactions(prisma, await requireRole("ADMIN"), input) } as const; }
  catch (error) { return failure(error); }
}
