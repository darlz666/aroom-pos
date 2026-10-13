"use server";
import { unstable_rethrow } from "next/navigation";
import { requireRole } from "./authorization";
import { getSessionIdentity, deleteSession } from "./session";
import { prisma } from "../db";
import { RecoveryError } from "./recovery-domain";
import { changePassword, readResetStatus, resetUserPassword } from "./recovery-service";

function failure(error: unknown) {
  unstable_rethrow(error);
  return { success: false, code: error instanceof RecoveryError ? error.code : "UNAVAILABLE" } as const;
}
async function identity() {
  const actor = await getSessionIdentity();
  if (!actor) throw new RecoveryError("FORBIDDEN");
  return actor;
}
export async function resetPasswordAction(input: unknown) {
  try {
    await requireRole("ADMIN");
    return { success: true, ...await resetUserPassword(prisma, await identity(), input) } as const;
  } catch (error) { return failure(error); }
}
export async function resetStatusAction(userId: unknown, operationId?: unknown) {
  try {
    await requireRole("ADMIN");
    return { success: true, status: await readResetStatus(prisma, await identity(), userId, operationId) } as const;
  } catch (error) { return failure(error); }
}
export async function changePasswordAction(input: unknown) {
  try {
    await changePassword(prisma, await identity(), input);
    await deleteSession();
    return { success: true } as const;
  } catch (error) { return failure(error); }
}
