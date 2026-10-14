import "server-only";

import type { User } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { normalizeLoginIdentifier } from "./login-identifier";
import { verifyPassword } from "./password";
import { PASSWORD_MAX_LENGTH } from "./password-validation";
import { admitAuthentication } from "./throttle";

// Fixed public dummy, generated with hashPassword's Argon2id defaults; not a credential.
// Verify it for missing users to perform the same password work as a wrong password.
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$Qn+p/uyKX2PXhF5sNkPM+A$JXNCEWug+VcTCg2nfaZhsRd4LDqEBn0X8yuMGElL3vU";

export type AuthenticatedUser = Pick<User, "id" | "name" | "loginIdentifier" | "role">;

export const safeUserSelect = {
  id: true, name: true, loginIdentifier: true, role: true,
} as const;

export async function authenticateCredentials(
  loginIdentifier: unknown,
  password: unknown,
): Promise<(AuthenticatedUser & { credentialsVersion: number }) | null> {
  if (
    typeof loginIdentifier !== "string" || loginIdentifier.length > 128 ||
    typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH * 2 ||
    password.length === 0 || Array.from(password).length > PASSWORD_MAX_LENGTH
  ) return null;

  const normalized = normalizeLoginIdentifier(loginIdentifier);
  if (!normalized) return null;
  if (!await admitAuthentication(prisma, "LOGIN", normalized)) return null;

  const user = await prisma.user.findUnique({
    where: { loginIdentifier: normalized },
    select: { ...safeUserSelect, passwordHash: true, active: true, credentialsVersion: true, mustChangePassword: true, temporaryCredentialExpiresAt: true },
  });
  const passwordMatches = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
  if (!user || !passwordMatches || !user.active || (user.mustChangePassword && (!user.temporaryCredentialExpiresAt || user.temporaryCredentialExpiresAt.getTime() <= Date.now()))) {
    return null;
  }
  return { id: user.id, name: user.name, loginIdentifier: user.loginIdentifier, role: user.role, credentialsVersion: user.credentialsVersion };
}
