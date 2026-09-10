import "server-only";

import { prisma } from "@/lib/db";
import { safeUserSelect, type AuthenticatedUser } from "./credentials";
import { getSessionIdentity } from "./session";

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const identity = await getSessionIdentity();
  if (!identity) return null;
  return prisma.user.findFirst({
    where: { id: identity.userId, active: true },
    select: safeUserSelect,
  });
}
