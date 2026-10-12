import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { draftInput, mutationInput, operations, statuses, transition } from "./domain";

const line = () => ({ id: randomUUID(), proposedIngredient: { name: "Milk", baseUnit: "ml" }, purchaseQuantity: "6", purchaseUnit: "L", estimatedUnitPrice: 33333 });
test("PO estimates preserve exact purchase prices, conversions and integer invoice totals", () => {
  for (const [unit, baseUnit] of [["g", "g"], ["kg", "g"], ["ml", "ml"], ["L", "ml"], ["pcs", "pcs"]]) {
    const input = draftInput({ supplierId: randomUUID(), lines: [{ ...line(), purchaseUnit: unit, proposedIngredient: { name: "Item", baseUnit } }] });
    assert.equal(input.estimatedTotal, 199998); assert.equal(input.lines[0].purchaseQuantity, "6");
  }
  const data = { supplierId: randomUUID(), lines: [line()] };
  for (const change of [{ purchaseQuantity: "0" }, { purchaseQuantity: "0.0001" }, { purchaseQuantity: "0.001" },
    { purchaseQuantity: "999999999999999.999" }, { estimatedUnitPrice: 1.5 }, { estimatedUnitPrice: null },
    { estimatedUnitPrice: -1 }, { estimatedUnitPrice: 2147483648 }, { purchaseUnit: "pcs" }, { purchaseUnit: "bottle" },
    { baseQuantity: "6000" }, { ingredientId: randomUUID() }]) {
    assert.throws(() => draftInput({ ...data, lines: [{ ...data.lines[0], ...change }] }), { code: "INVALID_INPUT" });
  }
  assert.throws(() => draftInput({ ...data, lines: [] }));
  assert.throws(() => draftInput({ ...data, lines: Array.from({ length: 101 }, line) }));
  assert.throws(() => draftInput({ ...data, estimatedTotal: 1 }));
  assert.throws(() => draftInput({ ...data, lines: [line(), { ...line(), proposedIngredient: { name: " milk ", baseUnit: "ml" } }] }), { code: "DUPLICATE_INGREDIENT" });
  const item = { id: randomUUID(), ingredientId: randomUUID(), purchaseQuantity: 1, purchaseUnit: "pcs", estimatedUnitPrice: 2147483647 };
  assert.equal(draftInput({ ...data, lines: [item] }).estimatedTotal, 2147483647);
  assert.throws(() => draftInput({ ...data, lines: [item, { ...item, id: randomUUID(), ingredientId: randomUUID() }] }));
  assert.throws(() => draftInput({ ...data, lines: [item, { ...item, id: randomUUID() }] }), { code: "DUPLICATE_INGREDIENT" });
});
test("PO transition matrix denies all unsupported roles/states and self decisions", () => {
  const valid = new Set(["STOCK_MANAGEMENT/CREATE/null", "STOCK_MANAGEMENT/EDIT/DRAFT", "STOCK_MANAGEMENT/SUBMIT/DRAFT",
    "FINANCE/APPROVE/WAITING_APPROVAL", "FINANCE/REJECT/WAITING_APPROVAL", "STOCK_MANAGEMENT/ORDER/APPROVED"]);
  for (const role of ["ADMIN", "CASHIER", "STOCK_MANAGEMENT", "FINANCE", "PROCUREMENT"] as const) {
    for (const operation of operations) for (const status of [null, ...statuses]) {
      if (valid.has(`${role}/${operation}/${status}`)) assert.ok(transition(role, operation, status));
      else assert.throws(() => transition(role, operation, status));
    }
  }
  for (const operation of ["APPROVE", "REJECT"] as const) assert.throws(() => transition("FINANCE", operation, "WAITING_APPROVAL", true), { code: "FORBIDDEN" });
});
test("mutation validation requires revision and rejection reason and rejects receiving/cancellation", () => {
  const input = { id: randomUUID(), key: randomUUID(), revision: 1, operation: "REJECT", note: "Price unclear" };
  assert.equal(mutationInput(input).note, "Price unclear");
  for (const change of [{ note: "   " }, { note: null }, { revision: 0 }, { revision: 1.1 }, { revision: 2147483647 },
    { operation: "RECEIVE" }, { operation: "CANCEL" }, { status: "APPROVED" }, { actorId: randomUUID() }]) assert.throws(() => mutationInput({ ...input, ...change }));
});
