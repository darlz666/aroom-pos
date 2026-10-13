import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { validatePassword } from "./password-validation";
import { changePasswordInput, resetInput } from "./recovery-domain";

test("new-password boundaries, Unicode, exact bytes and malformed input", () => {
  for (const n of [11, 129]) assert.equal(validatePassword("a".repeat(n)), false);
  for (const n of [12, 128]) { assert.equal(validatePassword("a".repeat(n)), true); assert.equal(validatePassword("😀".repeat(n)), true); }
  for (const value of [null, undefined, 123, {}, [], " ".repeat(20), "\t\n".repeat(20), "\uD800".repeat(12)]) assert.equal(validatePassword(value), false);
  const password = " exact password bytes ";
  assert.equal(changePasswordInput({ newPassword: password, confirmation: password }).newPassword, password);
  assert.throws(() => changePasswordInput({ newPassword: password, confirmation: password.trim() }));
});
test("recovery request rejects client authority, invalid identities and stale-version shapes", () => {
  const input = { operationId: randomUUID(), userId: randomUUID(), expectedVersion: 1, adminPassword: "legacy" };
  assert.deepEqual(resetInput(input), input);
  for (const patch of [{ operationId: "bad" }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483647 }, { actorId: randomUUID() }, { temporaryPassword: "forged" }, { adminPassword: null }]) assert.throws(() => resetInput({ ...input, ...patch }));
});
