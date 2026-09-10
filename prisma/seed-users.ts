import type { Prisma } from "../src/generated/prisma/client";
import { normalizeLoginIdentifier } from "../src/lib/auth/login-identifier";
import { validatePassword } from "../src/lib/auth/password-validation";
import { hashPassword } from "../src/lib/auth/password";

// Reserved development identities: never derive identity from a mutable login.
export const developmentUserIds = {
  ADMIN: "a2000000-0000-4000-8000-000000000201",
  CASHIER: "a2000000-0000-4000-8000-000000000202",
} as const;

// Only this error's controlled messages may be shown by the CLI.
export class DevelopmentUserSeedError extends Error {}

export function readDevelopmentUsers(env: NodeJS.ProcessEnv = process.env) {
  if (process.env.NODE_ENV === "production" || env.NODE_ENV === "production") {
    throw new DevelopmentUserSeedError("Development users cannot be provisioned in production.");
  }
  const users = (["ADMIN", "CASHIER"] as const).map((role) => {
    const required = (field: string) => {
      const key = `AROOM_DEV_${role}_${field}`;
      const value = env[key];
      if (!value || !value.trim()) {
        throw new DevelopmentUserSeedError(`${key} must be configured locally.`);
      }
      return value;
    };
    const name = required("NAME").trim();
    const loginIdentifier = normalizeLoginIdentifier(required("LOGIN"));
    const password = required("PASSWORD");
    if (!validatePassword(password)) {
      throw new DevelopmentUserSeedError(`AROOM_DEV_${role}_PASSWORD must contain 12 to 128 characters.`);
    }
    return { id: developmentUserIds[role], role, name, loginIdentifier, password };
  });
  if (users[0].loginIdentifier === users[1].loginIdentifier) {
    throw new DevelopmentUserSeedError("Development user logins must be distinct after normalization.");
  }
  return users;
}

// Caller owns the transaction so both users (and the menu) commit or roll back together.
export async function seedUsers(tx: Prisma.TransactionClient, env: NodeJS.ProcessEnv = process.env) {
  const users = readDevelopmentUsers(env);
  for (const user of users) {
    const owner = await tx.user.findUnique({
      where: { loginIdentifier: user.loginIdentifier }, select: { id: true },
    });
    if (owner && owner.id !== user.id) {
      throw new DevelopmentUserSeedError("A development login is already assigned to another user. Choose distinct unused logins.");
    }
  }
  for (const { id, password, ...fields } of users) {
    const data = { ...fields, active: true, passwordHash: await hashPassword(password) };
    await tx.user.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
}
