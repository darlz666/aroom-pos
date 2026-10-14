import "server-only";
import { createHmac } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client";

export type ThrottleScope = "LOGIN" | "REAUTH";
export class AuthenticationUnavailable extends Error {
  constructor() { super("Authentication unavailable"); }
}

export function throttleKey(scope: ThrottleScope, identity: string): string {
  // Canonical padded standard base64; never fall back to the session signing key.
  const encoded = process.env.AUTH_THROTTLE_HMAC_SECRET;
  if (!encoded || encoded.length > 88 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new AuthenticationUnavailable();
  const secret = Buffer.from(encoded, "base64");
  if (secret.length < 32 || secret.length > 64 || secret.toString("base64") !== encoded ||
    new Set(secret).size < 16 || encoded === process.env.SESSION_SECRET ||
    secret.equals(Buffer.from(process.env.SESSION_SECRET ?? "", "utf8"))) throw new AuthenticationUnavailable();
  // Reject obvious repeated or sequential material; this is not an entropy proof.
  for (let period = 1; period <= secret.length / 2; period++) {
    if (secret.every((byte, index) => byte === secret[index % period])) throw new AuthenticationUnavailable();
  }
  if ([1, 255].some(step => secret.every((byte, index) => !index || byte === (secret[index - 1] + step) % 256))) throw new AuthenticationUnavailable();
  return createHmac("sha256", secret).update(`aroom:auth-throttle:v1:${scope}\0${identity}`).digest("hex");
}

// No IP/header input: Cloudflare ingress trust has NOT been verified.
// One autocommit statement reserves attempts before password work. It must never
// run inside the credential transaction, which may roll back on a wrong password.
export async function admitAuthentication(db: Pick<PrismaClient, "$queryRaw">, scope: ThrottleScope, identity: string): Promise<boolean> {
  const key = throttleKey(scope, identity);
  const limit = scope === "LOGIN" ? 10 : 5;
  try {
    const rows = await db.$queryRaw<{ attempts: number }[]>`
      INSERT INTO "AuthThrottle" ("scope", "key", "attempts", "expiresAt")
      VALUES (${scope}, ${key}, 1, statement_timestamp() + interval '15 minutes')
      ON CONFLICT ("scope", "key") DO UPDATE SET
        "attempts" = CASE WHEN "AuthThrottle"."expiresAt" <= statement_timestamp() THEN 1 ELSE "AuthThrottle"."attempts" + 1 END,
        "expiresAt" = CASE WHEN "AuthThrottle"."expiresAt" <= statement_timestamp() THEN statement_timestamp() + interval '15 minutes' ELSE "AuthThrottle"."expiresAt" END
      WHERE "AuthThrottle"."expiresAt" <= statement_timestamp() OR "AuthThrottle"."attempts" < ${limit}
      RETURNING "attempts"`;
    return rows.length === 1;
  } catch { throw new AuthenticationUnavailable(); }
}

// Bounded maintenance; expired rows are never needed to enforce a current window.
export async function pruneAuthenticationAttempts(db: Pick<PrismaClient, "$executeRaw">) {
  return db.$executeRaw`WITH expired AS MATERIALIZED (
    SELECT "scope", "key" FROM "AuthThrottle" WHERE "expiresAt" < statement_timestamp() - interval '24 hours'
    ORDER BY "expiresAt" LIMIT 500 FOR UPDATE SKIP LOCKED)
    DELETE FROM "AuthThrottle" USING expired WHERE "AuthThrottle"."scope" = expired."scope" AND "AuthThrottle"."key" = expired."key"`;
}
