"use server";

import { authenticateCredentials } from "./credentials";
import { createSession, deleteSession } from "./session";
import { AuthenticationUnavailable } from "./throttle";

export async function loginAction(loginIdentifier: unknown, password: unknown) {
  const user = await authenticateCredentials(loginIdentifier, password).catch(error => {
    if (error instanceof AuthenticationUnavailable) return null;
    throw error;
  });
  if (!user) return { success: false, error: "Login atau password salah." } as const;
  await createSession(user.id, user.credentialsVersion);
  return { success: true } as const;
}

export async function logoutAction() {
  await deleteSession();
  return { success: true } as const;
}
