"use server";

import { authenticateCredentials } from "./credentials";
import { createSession, deleteSession } from "./session";

export async function loginAction(loginIdentifier: unknown, password: unknown) {
  const user = await authenticateCredentials(loginIdentifier, password);
  if (!user) return { success: false, error: "Login atau password salah." } as const;
  await createSession(user.id);
  return { success: true } as const;
}

export async function logoutAction() {
  await deleteSession();
  return { success: true } as const;
}
