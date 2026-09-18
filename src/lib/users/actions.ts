"use server";

import { unstable_rethrow } from "next/navigation";
import { requireRole } from "../auth/authorization";
import { prisma } from "../db";
import { UserManagementError } from "./domain";
import { changeUserRole, createUser, listUsers, setUserActive } from "./service";

const messages = {
  FORBIDDEN: "Access Management hanya tersedia untuk Admin aktif.",
  INVALID_INPUT: "Periksa isian. Nama dan login wajib diisi (maksimal 128 karakter); password harus 12–128 karakter.",
  INVALID_ROLE: "Pilih role yang valid.",
  DUPLICATE_LOGIN: "Login sudah digunakan. Muat ulang daftar pengguna sebelum mencoba lagi.",
  NOT_FOUND: "Pengguna tidak ditemukan. Muat ulang daftar pengguna.",
  SELF_ACCESS_CHANGE: "Anda tidak dapat menonaktifkan akun sendiri atau mengubah role sendiri dari ADMIN.",
  LAST_ADMIN: "Setidaknya satu ADMIN harus tetap aktif.",
  UNAVAILABLE: "Status belum dapat dipastikan. Periksa koneksi dan muat ulang daftar pengguna sebelum mencoba lagi.",
};
function failure(error: unknown) {
  unstable_rethrow(error);
  const code = error instanceof UserManagementError ? error.code : "UNAVAILABLE";
  return { success: false, code, error: messages[code] } as const;
}
export async function listUsersAction() {
  try {
    const actor = await requireRole("ADMIN");
    return { success: true, users: await listUsers(prisma, actor) } as const;
  } catch (error) { return failure(error); }
}
export async function createUserAction(input: unknown) {
  try {
    const actor = await requireRole("ADMIN");
    return { success: true, user: await createUser(prisma, actor, input) } as const;
  } catch (error) { return failure(error); }
}
export async function changeUserRoleAction(input: unknown) {
  try {
    const actor = await requireRole("ADMIN");
    return { success: true, user: await changeUserRole(prisma, actor, input) } as const;
  } catch (error) { return failure(error); }
}
export async function setUserActiveAction(input: unknown) {
  try {
    const actor = await requireRole("ADMIN");
    return { success: true, user: await setUserActive(prisma, actor, input) } as const;
  } catch (error) { return failure(error); }
}
