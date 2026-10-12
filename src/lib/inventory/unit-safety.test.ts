import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ingredientInput, convertQuantity } from "./domain";
import { ingredientMasterInput } from "./ingredient-domain";
import { stockInInput, stockInLine } from "./stock-in-domain";

test("new ingredient entry points canonicalize purchase units without accepting balances or costs", () => {
  for (const [input, stored, minimum] of [["g", "g", "1.25"], ["kg", "g", "1250"],
    ["ml", "ml", "1.25"], ["L", "ml", "1250"], ["pcs", "pcs", "1.25"]]) {
    assert.deepEqual(ingredientMasterInput({ name: " Milk ", baseUnit: input }), { name: "Milk", baseUnit: stored });
    const data = ingredientInput({ name: "Milk", baseUnit: input, minimumStock: "1.25" });
    assert.equal(data.baseUnit, stored); assert.equal(data.minimumStock.toFixed(), minimum);
  }
  for (const unit of ["l", "KG", "bottle", "", null]) {
    assert.throws(() => ingredientMasterInput({ name: "Milk", baseUnit: unit }), { code: "INVALID_UNIT" });
  }
  for (const extra of [{ currentStock: "10" }, { weightedAverageUnitCostMicros: "100" }, { unitCost: 10 }]) {
    assert.throws(() => ingredientMasterInput({ name: "Milk", baseUnit: "L", ...extra }), { code: "INVALID_INPUT" });
  }
});

test("purchase-unit receipts preserve exact original terms and never mutate existing masters", () => {
  for (const [unit, baseUnit, qty, baseQty] of [["g", "g", "0.125", "0.125"], ["kg", "g", "0.125", "125"],
    ["ml", "ml", "0.125", "0.125"], ["L", "ml", "6", "6000"], ["pcs", "pcs", "0.125", "0.125"]] as const) {
    const ingredient = Object.freeze({ id: randomUUID(), name: "Existing", baseUnit, active: true });
    const input = stockInInput({ idempotencyKey: randomUUID(), supplierId: randomUUID(), receivedAt: "2026-10-09T09:00:00+07:00",
      items: [{ ingredientId: ingredient.id, quantity: qty, unit, purchaseUnitCost: 8000 }] });
    const line = stockInLine(input.items[0], ingredient);
    assert.equal(line.ingredientId, ingredient.id); assert.equal(line.baseUnit, baseUnit);
    assert.equal(line.baseQuantity.toFixed(), baseQty); assert.equal(line.inputQuantity.toFixed(), qty);
    assert.equal(line.inputUnit, unit); assert.equal(line.lineTotal, unit === "L" ? 48000 : 1000);
    assert.equal(ingredient.baseUnit, baseUnit);
  }
});

test("preconversion alone cannot encode fractional canonical unit prices in the legacy contract", () => {
  const ingredient = { id: randomUUID(), name: "Milk", baseUnit: "ml" as const, active: true };
  const request = { idempotencyKey: randomUUID(), supplierId: randomUUID(), receivedAt: "2026-10-09T09:00:00+07:00",
    items: [{ ingredientId: ingredient.id, quantity: "6", unit: "L", purchaseUnitCost: 33333 }] };
  const line = stockInLine(stockInInput(request).items[0], ingredient);
  assert.equal(line.baseQuantity.toFixed(), "6000"); assert.equal(line.lineTotal, 199998);
  assert.equal(line.receivedUnitCostMicros, BigInt(33333000));
  assert.throws(() => stockInInput({ ...request, items: [{ ingredientId: ingredient.id, quantity: "6000", unit: "ml", unitCost: 33.333 }] }));
  assert.throws(() => convertQuantity("0.0001", "L", "ml"), { code: "INVALID_QUANTITY" });
  assert.throws(() => convertQuantity("999999999999999.999", "kg", "g"), { code: "INVALID_QUANTITY" });
  assert.throws(() => convertQuantity("1", "pcs", "ml"), { code: "INCOMPATIBLE_UNIT" });
  const maximum = stockInInput({ ...request, items: [{ ingredientId: ingredient.id, quantity: "1", unit: "ml", purchaseUnitCost: 2147483647 }] });
  assert.equal(stockInLine(maximum.items[0], ingredient).lineTotal, 2147483647);
  assert.throws(() => stockInLine({ ...maximum.items[0], quantity: convertQuantity("2", "ml", "ml") }, ingredient), { code: "INVALID_COST" });
  assert.throws(() => stockInLine(stockInInput({ ...request, items: [{ ...request.items[0], quantity: "0.001" }] }).items[0], ingredient), { code: "INVALID_COST" });
});
