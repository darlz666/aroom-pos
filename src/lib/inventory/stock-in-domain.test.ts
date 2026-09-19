import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { stockInFingerprint, stockInInput, stockInLine } from "./stock-in-domain";

const ingredient = { id: randomUUID(), name: "Oatmilk", baseUnit: "ml" as const, active: true };
const item = { ingredientId: ingredient.id, quantity: "12", unit: "L", unitCost: 20 };
const input = { idempotencyKey: randomUUID(), supplierId: randomUUID(), receivedAt: "2026-09-18T08:00:00+07:00", items: [item] };

test("receiving uses exact canonical quantities and integer-rupiah costs", () => {
  const request = stockInInput(input);
  const line = stockInLine(request.items[0], ingredient);
  assert.equal(line.baseQuantity.toFixed(), "12000"); assert.equal(line.lineTotal, 240000);
  assert.equal(line.inputQuantity.toFixed(), "12"); assert.equal(line.inputUnit, "L");
  assert.equal(request.receivedAt.toISOString(), "2026-09-18T01:00:00.000Z");
  for (const [unit, baseUnit, quantity, cost, total] of [
    ["kg", "g", "1", 200, 200000], ["pcs", "pcs", "1000", 100, 100000],
    ["ml", "ml", "0.125", 8, 1], ["ml", "ml", "999999999999999.999", 0, 0],
    ["ml", "ml", "1", 2147483647, 2147483647],
  ] as const) {
    const normalized = stockInInput({ ...input, items: [{ ...item, unit, quantity, unitCost: cost }] });
    assert.equal(stockInLine(normalized.items[0], { ...ingredient, baseUnit }).lineTotal, total);
  }
});

test("receiving rejects untrusted totals/actors, invalid dates, duplicate lines and invalid money", () => {
  assert.throws(() => stockInInput({}), { code: "INVALID_ID" });
  for (const raw of [null, { ...input, actorId: randomUUID() }, { ...input, total: 1 }, { ...input, items: [] },
    { ...input, items: Array(101).fill(item) }, { ...input, notes: "x".repeat(1001) },
    ...["2026-09-18", "2026-09-18T08:00:00", "2026-02-30T00:00:00Z", "2026-09-18T24:00:00Z", "invalid"].map(receivedAt => ({ ...input, receivedAt })),
    ...["lineTotal", "baseQuantity", "stockAfter"].map(key => ({ ...input, items: [{ ...item, [key]: 1 }] })),
  ]) assert.throws(() => stockInInput(raw), { code: "INVALID_INPUT" });
  for (const unitCost of [null, undefined, -1, 0.5, NaN, Infinity, "20", 2147483648]) {
    assert.throws(() => stockInInput({ ...input, items: [{ ...item, unitCost }] }));
  }
  for (const quantity of [0, -1, "0.0001", "1000000000000000", Infinity]) {
    assert.throws(() => stockInInput({ ...input, items: [{ ...item, quantity }] }), { code: "INVALID_QUANTITY" });
  }
  assert.throws(() => stockInInput({ ...input, items: [item, { ...item, ingredientId: ingredient.id.toUpperCase() }] }), { code: "DUPLICATE_INGREDIENT" });
  for (const [quantity, unitCost] of [["0.001", 20], ["2147483648", 1], ["999999999999999.999", 2147483647]] as const) {
    const request = stockInInput({ ...input, items: [{ ...item, quantity, unit: "ml", unitCost }] });
    assert.throws(() => stockInLine(request.items[0], ingredient), { code: "INVALID_COST" });
  }
  for (const baseUnit of ["g", "pcs"] as const) assert.throws(() => stockInLine(stockInInput(input).items[0], { ...ingredient, baseUnit }), { code: "INCOMPATIBLE_UNIT" });
  assert.throws(() => stockInLine(stockInInput(input).items[0], { ...ingredient, active: false }), { code: "INGREDIENT_INACTIVE" });
});

test("idempotency fingerprints canonicalize formatting/order but bind actor and original intent", () => {
  const actorId = randomUUID();
  const second = { ...item, ingredientId: randomUUID() };
  const request = { ...input, items: [item, second] };
  const original = stockInFingerprint(actorId, stockInInput(request));
  assert.equal(stockInFingerprint(actorId, stockInInput({ ...request, receivedAt: "2026-09-18T01:00:00Z", notes: " ",
    items: [second, { ...item, quantity: "12.000" }] })), original);
  assert.notEqual(stockInFingerprint(randomUUID(), stockInInput(request)), original);
  for (const changed of [{ ...request, notes: "different" }, { ...request, supplierId: randomUUID() },
    { ...request, items: [{ ...item, unitCost: 21 }, second] }]) {
    assert.notEqual(stockInFingerprint(actorId, stockInInput(changed)), original);
  }
});
