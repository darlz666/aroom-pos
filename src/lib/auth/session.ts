import "server-only";

import { cookies } from "next/headers";
import { getSessionCookieOptions, SESSION_COOKIE_NAME } from "./cookie";
import { signSessionToken, verifySessionToken, type SessionIdentity } from "./session-token";

export async function createSession(userId: string): Promise<void> {
  const token = await signSessionToken({ userId });
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
}

export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const identity = await verifySessionToken(token);
  return identity ? { userId: identity.userId } : null;
}

export async function deleteSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(), maxAge: 0, expires: new Date(0),
  });
}
