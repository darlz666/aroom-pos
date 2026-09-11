"use server";

import { requireUser } from "../auth/authorization";
import { prisma } from "../db";
import { ShiftError } from "./domain";
import { getActiveRegisterState, openShift } from "./service";

function safeFailure(error: unknown) {
  if (error instanceof ShiftError) {
    if (error.code === "INVALID_MONEY") return { success: false, code: error.code, error: "Nominal kas awal tidak valid." } as const;
    if (error.code === "REGISTER_OCCUPIED") return { success: false, code: error.code, error: "Register sedang digunakan oleh shift lain." } as const;
    if (error.code === "FORBIDDEN") return { success: false, code: error.code, error: "Anda tidak memiliki izin untuk tindakan ini." } as const;
  }
  return { success: false, code: "UNAVAILABLE", error: "Shift belum dapat diproses. Periksa koneksi dan coba lagi." } as const;
}

export async function openShiftAction(openingCash: unknown) {
  const actor = await requireUser();
  try {
    const { state, shift } = await openShift(prisma, actor, openingCash);
    return { success: true, state, shift: {
      id: shift.id, openingCash: shift.openingCash, openedAt: shift.openedAt.toISOString(), status: shift.status,
    } } as const;
  } catch (error) {
    return safeFailure(error);
  }
}

export async function getActiveShiftAction() {
  const actor = await requireUser();
  try {
    return { success: true, ...await getActiveRegisterState(prisma, actor) } as const;
  } catch (error) {
    return safeFailure(error);
  }
}
