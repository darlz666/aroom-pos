import { validatePassword } from "./password-validation";

export class RecoveryError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "INVALID_INPUT" | "REAUTHENTICATE" | "STALE_VERSION" | "INTENT_CONFLICT" | "EXPIRED") { super(code); }
}
export function recoveryId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new RecoveryError("INVALID_INPUT");
  return value.toLowerCase();
}
export function credentialVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value >= 2147483647) throw new RecoveryError("INVALID_INPUT");
  return value;
}
function object(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new RecoveryError("INVALID_INPUT");
  return input as Record<string, unknown>;
}
export function currentPassword(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || Array.from(value).length > 128) throw new RecoveryError("INVALID_INPUT");
  return value;
}
export function resetInput(input: unknown) {
  const raw = object(input, ["operationId", "userId", "expectedVersion", "adminPassword"]);
  return { operationId: recoveryId(raw.operationId), userId: recoveryId(raw.userId), expectedVersion: credentialVersion(raw.expectedVersion), adminPassword: currentPassword(raw.adminPassword) };
}
export function changePasswordInput(input: unknown) {
  const raw = object(input, ["newPassword", "confirmation", "currentPassword"]);
  if (!validatePassword(raw.newPassword) || raw.newPassword !== raw.confirmation) throw new RecoveryError("INVALID_INPUT");
  return { newPassword: raw.newPassword, currentPassword: raw.currentPassword };
}
