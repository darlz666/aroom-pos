import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { SESSION_LIFETIME_SECONDS } from "./cookie";

export type SessionIdentity = { userId: string };
export type VerifiedSession = SessionIdentity & { iat: number; exp: number };

const ALGORITHM = "HS256";
const ISSUER = "aroom-pos";
const AUDIENCE = "aroom-pos:staff-session";

function getSessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  const key = new TextEncoder().encode(secret);
  if (!secret || secret.trim() !== secret || key.byteLength < 32) {
    throw new Error("SESSION_SECRET must be configured with a strong random secret of at least 32 bytes.");
  }
  return key;
}

function isUserId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function signSessionToken({ userId }: SessionIdentity): Promise<string> {
  const key = getSessionKey();
  if (!isUserId(userId)) {
    throw new Error("A nonempty userId is required.");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_LIFETIME_SECONDS)
    .sign(key);
}

// Identity verification only: future protected requests must load role/active
// status from PostgreSQL. Configuration errors remain distinct from bad tokens.
export async function verifySessionToken(token: string): Promise<VerifiedSession | null> {
  const key = getSessionKey();
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      typ: "JWT",
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["userId", "iat", "exp"],
      maxTokenAge: SESSION_LIFETIME_SECONDS,
    });
    const { userId, iat, exp } = payload;
    if (
      !isUserId(userId) ||
      typeof iat !== "number" || !Number.isInteger(iat) ||
      typeof exp !== "number" || !Number.isInteger(exp) ||
      exp - iat !== SESSION_LIFETIME_SECONDS ||
      Object.keys(payload).some((claim) => !["userId", "iat", "exp", "iss", "aud"].includes(claim))
    ) {
      return null;
    }
    return { userId, iat, exp };
  } catch {
    return null;
  }
}
