import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { compatibleUnits, receivingSubmission, restoreSubmission } from "./receiving-form";

test("receiving form sends input quantities and whole rupiah, never client balances/totals", () => {
  const fields = { supplierId: randomUUID(), receivedAt: "2026-09-18T10:15", notes: "Delivery", lines: [{ ingredientId: randomUUID(), quantity: "1,125", unit: "L", unitCost: "20" }] };
  const key = randomUUID(), result = receivingSubmission(fields, key);
  assert.equal(result.receivedAt, "2026-09-18T10:15:00+07:00"); assert.equal(result.items[0].quantity, "1.125"); assert.equal(result.items[0].unitCost, 20);
  assert.deepEqual(Object.keys(result).sort(), ["idempotencyKey", "items", "notes", "receivedAt", "supplierId"]);
  assert.deepEqual(restoreSubmission(JSON.stringify({ ...result, actorId: "forged", total: 1 })), result);
  assert.deepEqual(compatibleUnits("ml"), ["ml", "L"]); assert.deepEqual(compatibleUnits("g"), ["g", "kg"]); assert.deepEqual(compatibleUnits("pcs"), ["pcs"]);
  for (const unitCost of ["", "1.5", "20,000", "1e3", "-1", "2147483648"]) assert.throws(() => receivingSubmission({ ...fields, lines: [{ ...fields.lines[0], unitCost }] }, key));
  for (const quantity of ["", "0", "0.000", "-1", "1,000.00", "1e3", "0.0001"]) assert.throws(() => receivingSubmission({ ...fields, lines: [{ ...fields.lines[0], quantity }] }, key));
  assert.throws(() => receivingSubmission({ ...fields, lines: [fields.lines[0], fields.lines[0]] }, key));
  for (const raw of ["no JSON", "{}", "null", JSON.stringify({ ...result, items: [{}] })]) assert.throws(() => restoreSubmission(raw));
});
