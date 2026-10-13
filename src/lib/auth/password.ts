import "server-only";

import { hash, verify } from "@node-rs/argon2";
import { validatePassword } from "./password-validation";

export async function hashPassword(password: string): Promise<string> {
  if (!validatePassword(password)) {
    throw new Error("Password must contain 12 to 128 characters.");
  }

  // The library defaults to Argon2id and generates a fresh salt. Keep its costs.
  return hash(password);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
