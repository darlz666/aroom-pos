import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { defaultCup, normalizeCups, normalizeOptionalText, resizeCups, type CupCustomization } from "./customizations";
import { fingerprintCreateRequest, normalizeCreateRequest, normalizeEditRequest, priceOrder } from "./domain";

const first = "a2000000-0000-4000-8000-000000000001";
const second = "a2000000-0000-4000-8000-000000000002";
const request = () => ({ createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: first, quantity: 1 }] });

test("cup defaults are independent; quantity resize preserves prefixes and creates default units", () => {
  const a = defaultCup(); const b = defaultCup(); a.notes = "Individual cup";
  assert.equal(b.notes, "");
  const original: CupCustomization[] = [{ ...a, sugar: "NO_SUGAR" }, { ...b, cup: "LARGE" }];
  assert.deepEqual(resizeCups(original, 1), [original[0]]);
  const expanded = resizeCups(original, 4);
  assert.deepEqual(expanded, [...original, defaultCup(), defaultCup()]);
  expanded[0].notes = "Changed"; expanded[2].notes = "New";
  assert.equal(original[0].notes, "Individual cup"); assert.equal(expanded[3].notes, "");
  for (const quantity of [0, -1, 100, 1.5, Infinity]) assert.throws(() => resizeCups(original, quantity));
});

test("strict cup arrays accept all fixed options and preserve independent preparation per unit", () => {
  for (const sugar of ["NORMAL", "LESS", "NO_SUGAR"] as const) {
    for (const ice of ["NORMAL", "LESS", "NO_ICE"] as const) {
      for (const cup of ["REGULAR", "LARGE"] as const) {
        assert.deepEqual(normalizeCups([{ sugar, ice, cup, notes: "  oat milk  " }], 1), [{ sugar, ice, cup, notes: "oat milk" }]);
      }
    }
  }
  const cups = [defaultCup(), { ...defaultCup(), sugar: "LESS" as const }];
  assert.deepEqual(normalizeCups(cups, 2), cups);
  for (const value of [null, {}, [], Array(1), Array.from({ length: 100 }, defaultCup), [null], ["NORMAL"], [{ ...defaultCup(), sugar: "less" }],
    [{ ...defaultCup(), ice: "HOT" }], [{ ...defaultCup(), cup: "XL" }], [{ ...defaultCup(), price: 5000 }],
    [{ ...defaultCup(), notes: undefined }], [{ ...defaultCup(), notes: "x".repeat(301) }]]) assert.throws(() => normalizeCups(value));
  assert.throws(() => normalizeCups(cups, 1));
});

test("single-line text rejects controls and malformed Unicode; code-point limits retain normal Unicode", () => {
  assert.equal(normalizeOptionalText(undefined, 1), undefined);
  assert.equal(normalizeOptionalText("   ", 1), undefined);
  assert.equal(normalizeOptionalText(" 😀 ", 1), "😀");
  assert.equal(normalizeOptionalText("e\u0301", 2), "e\u0301");
  for (const value of [null, 1, true, {}, "😀😀", "\ud800", "\udfff", "text\nnew", "\u0000", "\u001b", "\u007f", "\u0085", "\u009f"]) {
    assert.throws(() => normalizeOptionalText(value, 1));
  }
});

test("legacy normalization and SHA-256 remain byte-for-byte compatible; blank optional fields omit", () => {
  const raw = request();
  const legacy = { createIdempotencyKey: raw.createIdempotencyKey, orderType: "DINE_IN" as const,
    items: [{ productId: first, quantity: 3 }, { productId: second, quantity: 1 }] };
  const normalized = normalizeCreateRequest({ ...raw, items: [{ productId: second, quantity: 1 }, { productId: first.toUpperCase(), quantity: 1 }, { productId: first, quantity: 2 }] });
  assert.deepEqual(normalized, legacy);
  const oldFingerprint = createHash("sha256").update(JSON.stringify({ orderType: legacy.orderType, items: legacy.items })).digest("hex");
  assert.equal(fingerprintCreateRequest(normalized), oldFingerprint);
  assert.deepEqual(normalizeCreateRequest({ ...legacy, customerName: "  ", items: legacy.items.map(item => ({ ...item, notes: "  " })) }), legacy);
});

test("explicit cups concatenate duplicate products in unit order and disallow ambiguous merged metadata", () => {
  const cup1 = { ...defaultCup(), sugar: "NO_SUGAR" as const }; const cup2 = { ...defaultCup(), ice: "LESS" as const };
  const raw = request();
  const normalized = normalizeCreateRequest({ ...raw, customerName: "  Dina  ", items: [
    { productId: first, quantity: 1, cups: [cup1], notes: "  takeaway  " },
    { productId: first, quantity: 1, cups: [cup2], notes: "takeaway" },
  ] });
  assert.equal(normalized.customerName, "Dina");
  assert.deepEqual(normalized.items, [{ productId: first, quantity: 2, cups: [cup1, cup2], notes: "takeaway" }]);
  const differentUnit = { ...normalized, items: [{ ...normalized.items[0], cups: [cup2, cup1] }] };
  assert.notEqual(fingerprintCreateRequest(normalized), fingerprintCreateRequest(differentUnit));
  assert.notEqual(fingerprintCreateRequest(normalized), fingerprintCreateRequest({ ...normalized, customerName: "Other" }));
  for (const items of [
    [{ productId: first, quantity: 2, cups: [cup1] }],
    [{ productId: first, quantity: 1, cups: [cup1] }, { productId: first, quantity: 1 }],
    [{ productId: first, quantity: 1, notes: "a" }, { productId: first, quantity: 1, notes: "b" }],
  ]) assert.throws(() => normalizeCreateRequest({ ...raw, items }), { code: "INVALID_INPUT" });
});

test("preparation choices never change authoritative selling prices or quantities", () => {
  const raw = normalizeCreateRequest({ ...request(), items: [{ productId: first, quantity: 2, cups: [
    { ...defaultCup(), cup: "LARGE" }, { ...defaultCup(), sugar: "NO_SUGAR", notes: "extra foam" },
  ], notes: "takeaway" }] });
  const priced = priceOrder(raw.items, [{ id: first, name: "Coffee", price: 22000, active: true, available: true }]);
  assert.equal(priced.total, 44000); assert.equal(priced.items[0].unitPriceSnapshot, 22000);
  assert.equal(priced.items[0].quantity, 2); assert.deepEqual(priced.items[0].cupCustomizations, raw.items[0].cups);
  assert.equal(priced.items[0].notes, "takeaway");
});

test("customization edits allow only preparation metadata and retain existing revision identity", () => {
  const base = { orderId: first, expectedRevision: 3 };
  assert.deepEqual(normalizeEditRequest({ ...base, operation: { type: "SET_CUSTOMER", customerName: "  AROOM  " } }),
    { ...base, operation: { type: "SET_CUSTOMER", customerName: "AROOM" } });
  assert.deepEqual(normalizeEditRequest({ ...base, operation: { type: "SET_CUSTOMER", customerName: " " } }),
    { ...base, operation: { type: "SET_CUSTOMER" } });
  assert.deepEqual(normalizeEditRequest({ ...base, operation: { type: "SET_ITEM_DETAILS", orderItemId: second } }),
    { ...base, operation: { type: "SET_ITEM_DETAILS", orderItemId: second } });
  for (const operation of [
    { type: "SET_CUSTOMER", customerName: "x".repeat(129) }, { type: "SET_CUSTOMER", customerName: "name\n" },
    { type: "SET_CUSTOMER", total: 0 }, { type: "SET_ITEM_DETAILS", orderItemId: second, price: 1 },
    { type: "SET_ITEM_DETAILS", orderItemId: second, notes: "x".repeat(501) },
    { type: "ADD_ITEM", productId: second, quantity: 2, cups: [defaultCup()] },
  ]) assert.throws(() => normalizeEditRequest({ ...base, operation }), { code: "INVALID_INPUT" });
});
