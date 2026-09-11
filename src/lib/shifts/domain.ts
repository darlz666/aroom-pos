import type { Shift, UserRole } from "../../generated/prisma/client";

// These actors must come from server authentication, never request payloads.
export type ShiftActor = { id: string; role: UserRole };
type ShiftIdentity = Pick<Shift, "cashierId" | "status">;
export const MAX_SHIFT_MONEY = 2_147_483_647;

export class ShiftError extends Error {
  constructor(public readonly code: "INVALID_MONEY" | "REGISTER_OCCUPIED" | "SHIFT_NOT_OPEN" | "FORBIDDEN" | "REASON_REQUIRED") {
    super(code);
    this.name = "ShiftError";
  }
}

/** Validate nonnegative integer rupiah that fits the existing PostgreSQL Int fields. */
export function validateShiftMoney(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SHIFT_MONEY) {
    throw new ShiftError("INVALID_MONEY");
  }
  return value;
}

/** Form text is digits only: no trimming, separators, signs or exponent syntax. */
export function parseShiftMoney(value: unknown): number {
  if (typeof value === "number") return validateShiftMoney(value);
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new ShiftError("INVALID_MONEY");
  return validateShiftMoney(Number(value));
}

export function calculateExpectedCash(openingCash: unknown, successfulCashAmount: unknown): number {
  return validateShiftMoney(validateShiftMoney(openingCash) + validateShiftMoney(successfulCashAmount));
}

export function calculateCashVariance(countedCash: unknown, expectedCash: unknown): number {
  return validateShiftMoney(countedCash) - validateShiftMoney(expectedCash);
}

function assertActor(actor: ShiftActor): void {
  if (!actor.id || (actor.role !== "ADMIN" && actor.role !== "CASHIER")) throw new ShiftError("FORBIDDEN");
}

export function assertCanOpenShift(actor: ShiftActor, activeShift: ShiftIdentity | null): void {
  assertActor(actor);
  if (activeShift !== null) throw new ShiftError("REGISTER_OCCUPIED");
  // Opening services must derive cashierId from actor.id.
}

export function assertCanOperateShift(actor: ShiftActor, shift: ShiftIdentity | null): void {
  assertActor(actor);
  if (!shift || shift.status !== "OPEN") throw new ShiftError("SHIFT_NOT_OPEN");
  if (actor.role !== "ADMIN" && shift.cashierId !== actor.id) throw new ShiftError("FORBIDDEN");
}

/** Permission only: closure still requires payment/order and reconciliation safeguards. */
export function assertCanCloseShift(actor: ShiftActor, shift: ShiftIdentity | null, reason?: unknown): void {
  assertCanOperateShift(actor, shift);
  if (shift!.cashierId !== actor.id && (typeof reason !== "string" || !reason.trim())) {
    throw new ShiftError("REASON_REQUIRED");
  }
}

export function shiftHistoryWhere(actor: ShiftActor): { cashierId?: string } {
  assertActor(actor);
  return actor.role === "ADMIN" ? {} : { cashierId: actor.id };
}

export function assertCanViewShift(actor: ShiftActor, shift: Pick<Shift, "cashierId">): void {
  assertActor(actor);
  if (actor.role !== "ADMIN" && actor.id !== shift.cashierId) throw new ShiftError("FORBIDDEN");
}
