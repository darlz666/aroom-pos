"use server";

import { requireOperator } from "../auth/authorization";
import { prisma } from "../db";
import { parseShiftMoney, ShiftError } from "./domain";
import { closeShift } from "./service";

const messages = {
  SHIFT_NOT_OPEN: "Shift sudah tidak aktif. Memuat status register terbaru...",
  FORBIDDEN: "Anda tidak memiliki izin untuk menutup shift ini.",
  INVALID_MONEY: "Masukkan kas fisik dalam angka rupiah utuh yang valid, tanpa tanda atau pemisah.",
  REASON_REQUIRED: "Isi alasan admin menutup shift milik pengguna lain.",
  DISCREPANCY_NOTE_REQUIRED: "Kas fisik berbeda dari kas yang diharapkan. Isi catatan selisih sebelum menutup shift.",
  UNRESOLVED_TRANSACTIONS: "Shift tidak dapat ditutup karena masih ada pesanan atau pembayaran yang belum selesai.",
  INVALID_INPUT: "Data penutupan shift tidak valid. Periksa isian dan coba lagi.",
  REGISTER_OCCUPIED: "Register sedang digunakan oleh shift lain. Muat ulang status register.",
};

export async function closeShiftAction(input: { shiftId: string; countedCash: string; discrepancyNote: string; adminCloseReason: string }) {
  const actor = await requireOperator();
  try {
    const result = await closeShift(prisma, actor, {
      shiftId: input.shiftId,
      countedCash: parseShiftMoney(input.countedCash),
      discrepancyNote: input.discrepancyNote,
      adminCloseReason: input.adminCloseReason,
    });
    return { success: true, expectedCash: result.expectedCash, countedCash: result.countedCash,
      cashVariance: result.cashVariance, closedAt: result.closedAt } as const;
  } catch (error) {
    if (error instanceof ShiftError) return { success: false, code: error.code, error: messages[error.code] } as const;
    return { success: false, code: "UNAVAILABLE", error: "Status penutupan belum dapat dipastikan. Periksa koneksi dan muat ulang status register sebelum mencoba lagi." } as const;
  }
}
