import "server-only";
import { requireUser } from "../auth/authorization";
import { prisma } from "../db";
import { recordManualPayment } from "./service";

// Server-only boundary, deliberately not a Server Action or HTTP endpoint.
export async function confirmManualPayment(input: unknown) {
  const actor = await requireUser();
  return recordManualPayment(prisma, actor, input);
}
