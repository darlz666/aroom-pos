import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { quantityString, receiptValues, receivingInput } from "./receiving-domain";

const request = () => ({ id: randomUUID(), key: randomUUID(), revision: 4, receivedAt: "2026-10-12T09:00:00+07:00",
  lines: [{ lineId: randomUUID(), quantity: "6", unit: "L", purchaseUnitCost: 33333 }] });
test("receiving compares equivalent quantities exactly, including fractional estimated rupiah", () => {
  const line = receivingInput(request()).lines[0];
  const approved = { baseUnit: "ml" as const, purchaseUnit: "L" as const, estimatedUnitPrice: 33333 };
  assert.deepEqual(receiptValues(line, approved), { baseQuantity: "6000", actualAmount: 199998,
    approvedEstimatedAmountMicros: BigInt(199998000000), priceVarianceMicros: BigInt(0) });
  const fractional = { ...line, quantity: "1", unit: "ml" as const, purchaseUnitCost: 34, varianceReason: "Invoice price" };
  assert.deepEqual(receiptValues(fractional, approved), { baseQuantity: "1", actualAmount: 34,
    approvedEstimatedAmountMicros: BigInt(33333000), priceVarianceMicros: BigInt(667000) });
  assert.throws(() => receiptValues({ ...fractional, varianceReason: null }, approved), { code: "VARIANCE_REASON_REQUIRED" });
  assert.equal(receiptValues({ ...fractional, purchaseUnitCost: 33, varianceReason: null }, approved).priceVarianceMicros, BigInt(-333000));
  assert.throws(() => receiptValues({ ...line, quantity: "0.001" }, approved), { code: "INVALID_INPUT" });
  for (const [n, expected] of [[0, "0"], [1, "0.001"], [100, "0.1"], [1000, "1"], [10000, "10"], [6000000, "6000"]] as const) assert.equal(quantityString(BigInt(n)), expected);
});
test("receiving requires explicit valid price, quantity, identities and resolution intent", () => {
  const input = request();
  for (const patch of [{ quantity: 0 }, { quantity: -1 }, { quantity: "0.0001" }, { quantity: "9999999999999999" },
    { purchaseUnitCost: undefined }, { purchaseUnitCost: null }, { purchaseUnitCost: -1 }, { purchaseUnitCost: 1.5 }, { purchaseUnitCost: 2147483648 },
    { unit: "liter" }, { actorId: randomUUID() }, { varianceReason: "   " }, { resolution: { type: "MATCH" } }, { resolution: { type: "CREATE", ingredientId: randomUUID() } }]) {
    assert.throws(() => receivingInput({ ...input, lines: [{ ...input.lines[0], ...patch }] }), { code: "INVALID_INPUT" });
  }
  assert.throws(() => receivingInput({ ...input, lines: [input.lines[0], input.lines[0]] }));
  assert.throws(() => receivingInput({ ...input, lines: [] }));
  assert.throws(() => receivingInput({ ...input, revision: 0 }));
  assert.throws(() => receivingInput({ ...input, receivedAt: "2026-10-12" }));
  assert.throws(() => receivingInput({ ...input, supplierId: randomUUID() }));
});
