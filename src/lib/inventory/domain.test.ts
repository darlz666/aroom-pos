import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { canonicalUnit, convertQuantity, ingredientInput, ingredientUnitCost, inventoryId, inventoryQuantity, inventoryUnit, recipeInput, supplierInput, validateRecipeReferences } from "./domain";

test("exact supported conversions and canonical ingredient units", () => {
  for (const [quantity, from, to, expected] of [
    [1, "kg", "g", "1000"], [1, "L", "ml", "1000"], [12, "L", "ml", "12000"],
    [100, "ml", "L", "0.1"], [125, "g", "kg", "0.125"], ["0.125", "kg", "g", "125"],
    ["0.001", "g", "g", "0.001"], [3, "pcs", "pcs", "3"],
  ] as const) assert.equal(convertQuantity(quantity, from, to).toString(), expected);
  assert.equal(canonicalUnit("kg"), "g"); assert.equal(canonicalUnit("L"), "ml");
  for (const unit of ["bottle", "liter", "l", "ML", "oz", "", undefined]) {
    assert.throws(() => inventoryUnit(unit), { code: "INVALID_UNIT" });
  }
  for (const [from, to] of [["g", "ml"], ["L", "kg"], ["pcs", "ml"]]) {
    assert.throws(() => convertQuantity(1, from, to), { code: "INCOMPATIBLE_UNIT" });
  }
});

test("quantities reject negative, nonfinite, overflow and excessive precision without rounding", () => {
  assert.equal(inventoryQuantity("999999999999999.999").toFixed(), "999999999999999.999");
  for (const value of [-1, "-0.001", NaN, Infinity, -Infinity, "NaN", "Infinity", null, undefined, true, {}, "", " ", "1e3", "0x10", "1,000", "1000000000000000", "0.0001"]) {
    assert.throws(() => inventoryQuantity(value), { code: "INVALID_QUANTITY" });
  }
  assert.equal(inventoryQuantity(0).toString(), "0");
  assert.throws(() => inventoryQuantity(0, true), { code: "INVALID_QUANTITY" });
  assert.throws(() => convertQuantity("999999999999999", "L", "ml"), { code: "INVALID_QUANTITY" });
  assert.throws(() => convertQuantity("0.001", "ml", "L"), { code: "INVALID_QUANTITY" });
});

test("ingredient metadata is normalized; client stock balances and invalid inputs are rejected", () => {
  const input = { name: " Oatmilk ", baseUnit: "L", minimumStock: "1.5", active: false };
  const value = ingredientInput(input);
  assert.equal(value.name, "Oatmilk"); assert.equal(value.baseUnit, "ml");
  assert.equal(value.minimumStock.toString(), "1500"); assert.equal(value.active, false);
  assert.equal(ingredientInput({ name: "Sugar", baseUnit: "kg" }).minimumStock.toString(), "0");
  for (const raw of [null, [], {}, { ...input, name: " " }, { ...input, name: "x".repeat(129) },
    { ...input, active: "true" }, { ...input, currentStock: 12000 }, { ...input, unitCost: 15 }, { ...input, id: randomUUID() }]) {
    assert.throws(() => ingredientInput(raw), { code: "INVALID_INPUT" });
  }
  for (const minimumStock of [-1, null, "0.0001", NaN]) {
    assert.throws(() => ingredientInput({ ...input, minimumStock }), { code: "INVALID_QUANTITY" });
  }
  assert.throws(() => ingredientInput({ ...input, baseUnit: "bottle" }), { code: "INVALID_UNIT" });
});

test("optional cost is integer rupiah per canonical unit, never a calculation", () => {
  for (const value of [0, 25, 2_147_483_647, null]) assert.equal(ingredientUnitCost(value), value);
  assert.equal(ingredientUnitCost(undefined), null);
  for (const value of [-1, 1.5, "25", Infinity, NaN, 2_147_483_648]) assert.throws(() => ingredientUnitCost(value), { code: "INVALID_INPUT" });
});

test("supplier validation supports optional details and active/inactive", () => {
  assert.deepEqual(supplierInput({ name: " Distributor ", contact: " Lia ", phone: " +62 123 ", address: " Jakarta ", active: false }), {
    name: "Distributor", contact: "Lia", phone: "+62 123", address: "Jakarta", active: false,
  });
  assert.deepEqual(supplierInput({ name: "Supplier", phone: "  " }), { name: "Supplier", contact: null, phone: null, address: null, active: true });
  for (const raw of [null, [], {}, { name: " " }, { name: "Supplier", active: 1 }, { name: "Supplier", phone: 123 },
    { name: "Supplier", invoice: "not supported" }, { name: "Supplier", address: "x".repeat(1001) }]) {
    assert.throws(() => supplierInput(raw), { code: "INVALID_INPUT" });
  }
});

test("recipes share ingredient references; canonical consumption quantities do not allocate stock", () => {
  const ingredient = { id: randomUUID(), baseUnit: "ml" as const };
  for (const [quantity, unit, expected] of [[100, "ml", "100"], ["0.15", "L", "150"], [120, "ml", "120"]] as const) {
    const product = { id: randomUUID() };
    const request = recipeInput({ productId: product.id.toUpperCase(), items: [{ ingredientId: ingredient.id.toUpperCase(), quantity, unit }] });
    const result = validateRecipeReferences(request, product, [ingredient]);
    assert.equal(result.productId, product.id); assert.equal(result.items[0].ingredientId, ingredient.id);
    assert.equal(result.items[0].unit, "ml"); assert.equal(result.items[0].quantity.toString(), expected);
    assert.equal("currentStock" in result.items[0], false);
  }
});

test("recipe references, positive quantities, duplicate ingredients and units are validated", () => {
  const product = { id: randomUUID() }, ingredient = { id: randomUUID(), baseUnit: "ml" as const };
  const item = { ingredientId: ingredient.id, quantity: 100, unit: "ml" };
  const input = { productId: product.id, items: [item] };
  for (const id of ["bad", "", null, 5]) assert.throws(() => inventoryId(id), { code: "INVALID_ID" });
  assert.throws(() => recipeInput({ ...input, productId: "bad" }), { code: "INVALID_ID" });
  assert.throws(() => recipeInput({ ...input, items: [{ ...item, ingredientId: "bad" }] }), { code: "INVALID_ID" });
  assert.throws(() => recipeInput({ ...input, items: [item, { ...item, ingredientId: ingredient.id.toUpperCase() }] }), { code: "DUPLICATE_INGREDIENT" });
  for (const quantity of [0, -1, "0", "0.0001", Infinity]) assert.throws(() => recipeInput({ ...input, items: [{ ...item, quantity }] }), { code: "INVALID_QUANTITY" });
  for (const items of [[], "oatmilk 100ml", ["oatmilk 100ml"], [{ ...item, stock: 500 }]]) assert.throws(() => recipeInput({ ...input, items }), { code: "INVALID_INPUT" });
  const request = recipeInput(input);
  assert.throws(() => validateRecipeReferences(request, null, [ingredient]), { code: "PRODUCT_NOT_FOUND" });
  assert.throws(() => validateRecipeReferences(request, { id: randomUUID() }, [ingredient]), { code: "PRODUCT_NOT_FOUND" });
  assert.throws(() => validateRecipeReferences(request, product, []), { code: "INGREDIENT_NOT_FOUND" });
  assert.throws(() => validateRecipeReferences(recipeInput({ ...input, items: [{ ...item, unit: "g" }] }), product, [ingredient]), { code: "INCOMPATIBLE_UNIT" });
});
