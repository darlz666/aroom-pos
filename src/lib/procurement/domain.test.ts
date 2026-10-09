import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { draftInput, mutationInput, operations, statuses, total, transition } from "./domain";
import { userRoles, createUserInput, changeRoleInput } from "../users/domain";

const draft = { itemName: " Grinder ", category: "COFFEE_EQUIPMENT", quantity: 2, unit: "unit", estimatedUnitPrice: 5000000, priority: "NORMAL", reason: "Replace equipment" };
const create = () => ({ id: randomUUID(), key: randomUUID(), revision: 0, operation: "CREATE", data: draft });
test("PROCUREMENT can be assigned through both user management operations", () => {
  assert.ok(userRoles.includes("PROCUREMENT"));
  assert.equal(createUserInput({ name: "Buyer", loginIdentifier: "buyer", password: "long password", role: "PROCUREMENT" }).role, "PROCUREMENT");
  assert.equal(changeRoleInput({ userId: randomUUID(), role: "PROCUREMENT" }).role, "PROCUREMENT");
});
test("normalizes inputs and computes bounded integer totals", () => {
  assert.equal(draftInput(draft).estimatedTotal, 10000000);
  assert.equal(draftInput(draft).itemName, "Grinder");
  assert.equal(total(1, 2147483647), 2147483647);
  assert.equal(total(2, 0), 0);
  for (const args of [[2, 2147483647], [2147483647, 2147483647], [0, 1], [1, -1], [1, 1.5], [1.5, 1]]) assert.throws(() => total(args[0], args[1]));
});
test("strict payloads reject actors, status, totals, malformed strings, dates, URLs and money", () => {
  for (const patch of [{ actorId: randomUUID() }, { estimatedTotal: 1 }, { status: "APPROVED" }, { createdBy: randomUUID() }, { actualTotal: 1 }]) {
    assert.throws(() => mutationInput({ ...create(), ...patch }));
    assert.throws(() => draftInput({ ...draft, ...patch }));
  }
  for (const patch of [{ itemName: " " }, { reason: "" }, { unit: "a".repeat(31) }, { itemName: "x\u0000" }, { quantity: 0 }, { estimatedUnitPrice: "100" },
    { quantity: 1.1 }, { estimatedUnitPrice: -1 }, { category: "INGREDIENT" }, { priority: "LOW" }, { neededDate: "2026-02-30" }, { neededDate: "2026-1-01" },
    { productUrl: "javascript:alert(1)" }, { productUrl: "ftp://example.com" }, { productUrl: "https://user:pass@example.com" }, { notes: "x".repeat(2001) }]) assert.throws(() => draftInput({ ...draft, ...patch }));
  assert.equal(draftInput({ ...draft, neededDate: "2028-02-29", productUrl: "https://example.com/item" }).neededDate?.toISOString(), "2028-02-29T00:00:00.000Z");
});
test("requires cancellation/rejection reasons and permits actual price only at ORDER", () => {
  const base = { id: randomUUID(), key: randomUUID(), revision: 2 };
  for (const operation of ["CANCEL", "REJECT"]) {
    for (const note of [undefined, "", " "]) assert.throws(() => mutationInput({ ...base, operation, note }));
    assert.equal(mutationInput({ ...base, operation, note: " Budget " }).note, "Budget");
  }
  assert.equal(mutationInput({ ...base, operation: "ORDER", actualUnitPrice: 0 }).actualUnitPrice, 0);
  assert.equal(mutationInput({ ...base, operation: "ORDER" }).actualUnitPrice, null);
  assert.throws(() => mutationInput({ ...base, operation: "RECEIVE", actualUnitPrice: 10 }));
  assert.throws(() => mutationInput({ ...base, operation: "APPROVE", data: draft }));
});
test("exhaustive role/state matrix permits only documented lifecycle transitions", () => {
  const valid = new Map([
    ["CREATE:null", "DRAFT"], ["EDIT:DRAFT", "DRAFT"], ["SUBMIT:DRAFT", "WAITING_APPROVAL"],
    ["APPROVE:WAITING_APPROVAL", "APPROVED"], ["REJECT:WAITING_APPROVAL", "REJECTED"],
    ["ORDER:APPROVED", "ORDERED"], ["RECEIVE:ORDERED", "RECEIVED"],
    ["CANCEL:DRAFT", "CANCELLED"], ["CANCEL:WAITING_APPROVAL", "CANCELLED"], ["CANCEL:APPROVED", "CANCELLED"],
  ]);
  for (const role of userRoles) for (const operation of operations) for (const status of [null, ...statuses]) {
    const expected = valid.get(`${operation}:${status}`), permittedRole = operation === "APPROVE" || operation === "REJECT" ? "FINANCE" : "PROCUREMENT";
    if (expected && role === permittedRole) assert.equal(transition(role, operation, status), expected);
    else assert.throws(() => transition(role, operation, status), `${role}:${operation}:${status}`);
  }
  assert.throws(() => transition("FINANCE", "APPROVE", "WAITING_APPROVAL", true));
  assert.throws(() => transition("FINANCE", "REJECT", "WAITING_APPROVAL", true));
});
