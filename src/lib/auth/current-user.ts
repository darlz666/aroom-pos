import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { safeUserSelect, type AuthenticatedUser } from "./credentials";
import { getSessionIdentity } from "./session";

// Restricted identities are exclusively for password change and logout.
export async function getPasswordChangeUser() {
  const identity = await getSessionIdentity();
  if (!identity) return null;
  const user = await prisma.user.findFirst({
    where: { id: identity.userId, active: true, credentialsVersion: identity.credentialsVersion },
    select: { ...safeUserSelect, credentialsVersion: true, mustChangePassword: true, temporaryCredentialExpiresAt: true },
  });
  if (!user || user.credentialsVersion !== identity.credentialsVersion ||
    (user.mustChangePassword && (!user.temporaryCredentialExpiresAt || user.temporaryCredentialExpiresAt.getTime() <= Date.now()))) return null;
  return user;
}
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const user = await getPasswordChangeUser();
  if (!user) return null;
  if (user.mustChangePassword) redirect("/change-password");
  return { id: user.id, name: user.name, loginIdentifier: user.loginIdentifier, role: user.role };
}
