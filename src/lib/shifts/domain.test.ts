import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCanCloseShift, assertCanOpenShift, assertCanOperateShift, assertCanViewShift, calculateCashVariance, calculateExpectedCash, MAX_SHIFT_MONEY, ShiftError, shiftHistoryWhere, validateShiftMoney } from "./domain";

const cashier = { id: "cashier", role: "CASHIER" } as const;
const admin = { id: "admin", role: "ADMIN" } as const;
const open = { cashierId: cashier.id, status: "OPEN" } as const;
const fails = (fn: () => unknown, code: ShiftError["code"]) => assert.throws(fn, (e: unknown) => e instanceof ShiftError && e.code === code);

test("money rejects coercion, fractions, negatives, nonfinite values and Int overflow", () => {
  for (const value of [null, undefined, "1000", true, -1, 0.5, NaN, Infinity, -Infinity, MAX_SHIFT_MONEY + 1]) {
    fails(() => validateShiftMoney(value), "INVALID_MONEY");
  }
  for (const value of [0, 22000, MAX_SHIFT_MONEY]) assert.equal(validateShiftMoney(value), value);
  assert.equal(calculateExpectedCash(100000, 22000), 122000);
  fails(() => calculateExpectedCash(MAX_SHIFT_MONEY, 1), "INVALID_MONEY");
  assert.equal(calculateCashVariance(0, MAX_SHIFT_MONEY), -MAX_SHIFT_MONEY);
  assert.equal(calculateCashVariance(MAX_SHIFT_MONEY, 0), MAX_SHIFT_MONEY);
  assert.equal(calculateCashVariance(22000, 22000), 0);
});

test("opening is allowed only on a free register for either role", () => {
  for (const actor of [cashier, admin]) {
    assertCanOpenShift(actor, null);
    fails(() => assertCanOpenShift(actor, open), "REGISTER_OCCUPIED");
  }
});

test("cashier ownership and ADMIN assistance, including closed/missing shifts", () => {
  assertCanOperateShift(cashier, open);
  assertCanOperateShift(admin, open);
  fails(() => assertCanOperateShift({ ...cashier, id: "other" }, open), "FORBIDDEN");
  for (const actor of [cashier, admin]) {
    assertCanOperateShift(actor, { ...open, cashierId: actor.id });
    for (const shift of [null, { ...open, status: "CLOSED" } as const]) {
      fails(() => assertCanOperateShift(actor, shift), "SHIFT_NOT_OPEN");
      fails(() => assertCanCloseShift(actor, shift, "reason"), "SHIFT_NOT_OPEN");
    }
  }
});

test("closing another owner's shift requires ADMIN and a nonblank reason", () => {
  assertCanCloseShift(cashier, open);
  assertCanCloseShift(admin, { ...open, cashierId: admin.id });
  for (const reason of [undefined, null, "", " \n\t", 42]) fails(() => assertCanCloseShift(admin, open, reason), "REASON_REQUIRED");
  assertCanCloseShift(admin, open, "Owner requested assistance");
  fails(() => assertCanCloseShift({ ...cashier, id: "other" }, open, "reason"), "FORBIDDEN");
});

test("history permissions are independent of POS assistance and shift status", () => {
  assert.deepEqual(shiftHistoryWhere(cashier), { cashierId: cashier.id });
  assert.deepEqual(shiftHistoryWhere(admin), {});
  assertCanViewShift(cashier, open);
  assertCanViewShift(admin, open);
  fails(() => assertCanViewShift(cashier, { cashierId: admin.id }), "FORBIDDEN");
});
