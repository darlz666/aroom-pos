import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { changeRoleInput, createUserInput, setActiveInput, userRoles } from "./domain";

const input = { name: " Staff ", loginIdentifier: " STAFF ", password: " untouched password ", role: "CASHIER" };
test("creation accepts all roles, normalizes identity, and preserves password", () => {
  for (const role of userRoles) assert.deepEqual(createUserInput({ ...input, role }), {
    name: "Staff", loginIdentifier: "staff", password: input.password, role,
  });
  for (const password of ["a".repeat(12), "a".repeat(128), "😀".repeat(128)]) {
    assert.equal(createUserInput({ ...input, password }).password, password);
  }
});
test("reject malformed payloads, privilege injection, invalid roles and password bounds", () => {
  for (const value of [null, [], "x", {}, { ...input, name: " " }, { ...input, name: "x".repeat(129) },
    { ...input, loginIdentifier: " " }, { ...input, loginIdentifier: "x".repeat(129) },
    { ...input, password: "a".repeat(11) }, { ...input, password: "😀".repeat(129) },
    { ...input, passwordHash: "forged" }, { ...input, active: false }, { ...input, actorId: randomUUID() }]) {
    assert.throws(() => createUserInput(value), { code: "INVALID_INPUT" });
  }
  for (const role of ["admin", "OWNER", null, 1]) assert.throws(() => createUserInput({ ...input, role }), { code: "INVALID_ROLE" });
  const userId = randomUUID();
  assert.deepEqual(changeRoleInput({ userId: userId.toUpperCase(), role: "FINANCE" }), { userId, role: "FINANCE" });
  assert.deepEqual(setActiveInput({ userId, active: false }), { userId, active: false });
  for (const value of [{ userId: "bad", active: true }, { userId, active: "false" }, { userId, active: true, role: "ADMIN" }]) {
    assert.throws(() => setActiveInput(value), { code: "INVALID_INPUT" });
  }
});
