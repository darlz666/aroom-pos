import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { COST_SCALE, MAX_COST_MICROS, ingredientHpp, purchaseLineTotal, roundHalfUp, weightedAverageCost } from "./costing";
import { stockInFingerprint, stockInInput, stockInLine } from "./stock-in-domain";

test("WAC initializes, weights quantities, and deterministically rounds repeated receipts", () => {
  assert.equal(weightedAverageCost("0", null, "12000", BigInt(35) * COST_SCALE), BigInt(35_000_000));
  assert.equal(weightedAverageCost("0", BigInt(99), "1", BigInt(0)), BigInt(0));
  const wac = weightedAverageCost("5000", BigInt(30_000_000), "12000", BigInt(35_000_000));
  assert.equal(wac, BigInt(33_529_412));
  assert.equal(ingredientHpp("100", wac), 3353);
  assert.equal(weightedAverageCost("17000", wac, "1000", BigInt(30_000_000)), BigInt(33_333_334));
  assert.equal(weightedAverageCost("1", BigInt(10_000_000), "1", BigInt(0)), BigInt(5_000_000));
  // Ties at one half of a micro-rupiah round upward; adjacent fractions do not.
  assert.equal(weightedAverageCost("1", BigInt(0), "1", BigInt(1)), BigInt(1));
  assert.equal(weightedAverageCost("1.001", BigInt(0), "1", BigInt(1)), BigInt(0));
  assert.equal(weightedAverageCost("0.999", BigInt(0), "1", BigInt(1)), BigInt(1));
  assert.equal(weightedAverageCost("0.125", BigInt(2_000_000), "0.375", BigInt(4_000_000)), BigInt(3_500_000));
});

test("HPP rounds each contribution to whole rupiah at explicit ties", () => {
  assert.equal(ingredientHpp("1", BigInt(499_999)), 0);
  assert.equal(ingredientHpp("1", BigInt(500_000)), 1);
  assert.equal(ingredientHpp("1", BigInt(500_001)), 1);
  assert.equal(ingredientHpp("0.001", BigInt(500_000_000)), 1);
  assert.equal(ingredientHpp("1", BigInt(500_000)) + ingredientHpp("1", BigInt(500_000)), 2);
  assert.equal(ingredientHpp("999999999999999.999", BigInt(0)), 0);
  assert.throws(() => ingredientHpp("2", MAX_COST_MICROS), { code: "INVALID_COST" });
});

test("integer arithmetic preserves huge products and near-half remainders", () => {
  const huge = BigInt("9999999999999999999999999999999999999");
  assert.equal(roundHalfUp(huge - BigInt(1), huge * BigInt(2)), BigInt(0));
  assert.equal(roundHalfUp(huge, huge * BigInt(2)), BigInt(1));
  assert.equal(weightedAverageCost("999999999999998.999", MAX_COST_MICROS, "1", MAX_COST_MICROS), MAX_COST_MICROS);
  assert.equal(ingredientHpp("1", MAX_COST_MICROS), 2147483647);
  assert.throws(() => weightedAverageCost("1", null, "1", BigInt(0)), { code: "UNKNOWN_INGREDIENT_COST" });
  assert.throws(() => weightedAverageCost("1", BigInt(-1), "1", BigInt(0)), { code: "INVALID_COST" });
  assert.throws(() => weightedAverageCost("0", null, "1", MAX_COST_MICROS + BigInt(1)), { code: "INVALID_COST" });
  assert.throws(() => weightedAverageCost("0", null, "0", BigInt(1)), { code: "INVALID_QUANTITY" });
  assert.throws(() => roundHalfUp(BigInt(1), BigInt(0)), { code: "INVALID_COST" });
});

test("purchase-unit input preserves original invoice terms and normalizes cost exactly", () => {
  const ingredient = { id: randomUUID(), name: "Oatmilk", baseUnit: "ml" as const, active: true };
  const request = { idempotencyKey: randomUUID(), supplierId: randomUUID(), receivedAt: "2026-09-18T08:00:00+07:00",
    items: [{ ingredientId: ingredient.id, quantity: "12", unit: "L", purchaseUnitCost: 35000 }] };
  const line = stockInLine(stockInInput(request).items[0], ingredient);
  assert.equal(line.inputQuantity.toFixed(), "12"); assert.equal(line.inputUnit, "L");
  assert.equal(line.baseQuantity.toFixed(), "12000"); assert.equal(line.receivedUnitCostMicros, BigInt(35_000_000));
  assert.equal(line.unitCost, null); assert.equal(line.purchaseUnitCost, 35000); assert.equal(line.lineTotal, 420000);
  for (const [unit, baseUnit] of [["L", "ml"], ["kg", "g"], ["pcs", "pcs"], ["ml", "ml"], ["g", "g"]] as const) {
    const normalized = stockInLine(stockInInput({ ...request, items: [{ ...request.items[0], unit, quantity: "1", purchaseUnitCost: 33333 }] }).items[0], { ...ingredient, baseUnit });
    assert.equal(normalized.receivedUnitCostMicros, BigInt(unit === "kg" || unit === "L" ? 33_333_000 : 33_333_000_000));
    assert.equal(normalized.lineTotal, 33333);
  }
  assert.throws(() => stockInInput({ ...request, items: [{ ...request.items[0], unitCost: 35 }] }), { code: "INVALID_COST" });
  for (const purchaseUnitCost of [-1, 1.5, "35000", null, 2147483648]) {
    assert.throws(() => stockInInput({ ...request, items: [{ ...request.items[0], purchaseUnitCost }] }));
  }
  assert.throws(() => purchaseLineTotal("0.001", BigInt(33_333_000)), { code: "INVALID_COST" });
  assert.throws(() => purchaseLineTotal("2", MAX_COST_MICROS), { code: "INVALID_COST" });
});

test("legacy persisted fingerprints stay identical; purchase-unit intent stays distinct", () => {
  const actorId = randomUUID(), ingredientId = randomUUID(), supplierId = randomUUID();
  const item = { ingredientId, quantity: "12", unit: "L", unitCost: 35 };
  const request = { idempotencyKey: randomUUID(), supplierId, receivedAt: "2026-09-18T08:00:00+07:00", items: [item] };
  const pre7e = createHash("sha256").update(JSON.stringify({ actorId, supplierId,
    receivedAt: "2026-09-18T01:00:00.000Z", notes: null, items: [item] })).digest("hex");
  assert.equal(stockInFingerprint(actorId, stockInInput(request)), pre7e);
  assert.notEqual(stockInFingerprint(actorId, stockInInput({ ...request,
    items: [{ ingredientId, quantity: "12", unit: "L", purchaseUnitCost: 35000 }] })), pre7e);
});
