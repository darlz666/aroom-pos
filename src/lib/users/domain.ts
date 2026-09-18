import type { User, UserRole } from "../../generated/prisma/client";
import { normalizeLoginIdentifier } from "../auth/login-identifier";
import { validatePassword } from "../auth/password-validation";

export const userRoles = ["ADMIN", "CASHIER", "STOCK_MANAGEMENT", "FINANCE"] as const satisfies readonly UserRole[];
export type ManagedUser = Pick<User, "id" | "name" | "loginIdentifier" | "role" | "active">;
export type UserActor = Pick<User, "id" | "role">;
export class UserManagementError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "INVALID_INPUT" | "INVALID_ROLE" | "DUPLICATE_LOGIN" | "NOT_FOUND" | "SELF_ACCESS_CHANGE" | "LAST_ADMIN") {
    super(code);
    this.name = "UserManagementError";
  }
}

export function userId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new UserManagementError("INVALID_INPUT");
  return value.toLowerCase();
}
export function userRole(value: unknown): UserRole {
  if (!userRoles.some(role => role === value)) throw new UserManagementError("INVALID_ROLE");
  return value as UserRole;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new UserManagementError("INVALID_INPUT");
  return value as Record<string, unknown>;
}
export function createUserInput(input: unknown) {
  const raw = object(input, ["name", "loginIdentifier", "password", "role"]);
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128 ||
      typeof raw.loginIdentifier !== "string" || raw.loginIdentifier.length > 128 || !normalizeLoginIdentifier(raw.loginIdentifier) ||
      typeof raw.password !== "string" || raw.password.length > 256 || !validatePassword(raw.password)) throw new UserManagementError("INVALID_INPUT");
  return { name: raw.name.trim(), loginIdentifier: normalizeLoginIdentifier(raw.loginIdentifier), password: raw.password, role: userRole(raw.role) };
}
export function changeRoleInput(input: unknown) {
  const raw = object(input, ["userId", "role"]);
  return { userId: userId(raw.userId), role: userRole(raw.role) };
}
export function setActiveInput(input: unknown) {
  const raw = object(input, ["userId", "active"]);
  if (typeof raw.active !== "boolean") throw new UserManagementError("INVALID_INPUT");
  return { userId: userId(raw.userId), active: raw.active };
}
