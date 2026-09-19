import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { recipeFingerprint, recipeSaveInput } from "./recipe-domain";
import { formatWac, restoreRecipeSubmission } from "./recipe-form";

const request = () => ({ productId: randomUUID(), expectedRevision: null, idempotencyKey: randomUUID(),
  items: [{ ingredientId: randomUUID(), quantity: "0.001", unit: "ml" }] });
test("recipe input reuses exact quantity validation, canonical units and bounded revisions", () => {
  const input = request();
  assert.equal(recipeSaveInput(input).items[0].quantity.toFixed(), "0.001");
  for (const patch of [{ expectedRevision: undefined }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: 2147483647 },
    { idempotencyKey: "invalid" }, { items: [] }, { price: 1 }, { total: 0 }, { items: Array(101).fill(input.items[0]) }]) {
    assert.throws(() => recipeSaveInput({ ...input, ...patch }));
  }
  for (const quantity of ["0", "-1", "1.0001", "1000000000000000", "1e3", "NaN"]) {
    assert.throws(() => recipeSaveInput({ ...input, items: [{ ...input.items[0], quantity }] }), { code: "INVALID_QUANTITY" });
  }
  for (const unit of ["L", "kg", "pack"]) assert.throws(() => recipeSaveInput({ ...input, items: [{ ...input.items[0], unit }] }), { code: "INVALID_UNIT" });
  assert.throws(() => recipeSaveInput({ ...input, items: [input.items[0], input.items[0]] }), { code: "DUPLICATE_INGREDIENT" });
});
test("retry fingerprint includes actor, product, revision and normalized ordered quantities", () => {
  const actor = randomUUID(), input = request();
  input.items.push({ ingredientId: randomUUID(), quantity: "1.000", unit: "g" });
  const fingerprint = recipeFingerprint(actor, recipeSaveInput(input));
  assert.equal(recipeFingerprint(actor, recipeSaveInput({ ...input, items: [...input.items].reverse().map(i => ({ ...i, quantity: i.quantity === "1.000" ? "1" : i.quantity })) })), fingerprint);
  assert.notEqual(recipeFingerprint(randomUUID(), recipeSaveInput(input)), fingerprint);
  assert.notEqual(recipeFingerprint(actor, recipeSaveInput({ ...input, expectedRevision: 1 })), fingerprint);
  assert.notEqual(recipeFingerprint(actor, recipeSaveInput({ ...input, productId: randomUUID() })), fingerprint);
});
test("browser recovery preserves exact intent and cost formatting preserves micro-rupiah", () => {
  const input = request();
  assert.deepEqual(restoreRecipeSubmission(JSON.stringify(input)), input);
  for (const value of ["null", "{}", "not json", JSON.stringify({ ...input, items: [] })]) assert.throws(() => restoreRecipeSubmission(value));
  assert.equal(formatWac(null), "Belum diketahui");
  assert.equal(formatWac("0"), "Rp0");
  assert.equal(formatWac("33529412"), "Rp33,529412");
  assert.equal(formatWac("2147483647000000"), "Rp2.147.483.647");
});
