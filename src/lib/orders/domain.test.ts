import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fingerprintCreateRequest, formatOrderNumber, MAX_ORDER_MONEY, normalizeCreateRequest, priceOrder } from "./domain";

const a = "a2000000-0000-4000-8000-000000000001";
const b = "a2000000-0000-4000-8000-000000000002";
const input = (quantity: unknown = 1) => ({ createIdempotencyKey: randomUUID(), orderType: "DINE_IN", items: [{ productId: a, quantity }] });
for (const quantity of [1, 99]) test(`quantity ${quantity} accepted`, () => {
  assert.equal(normalizeCreateRequest(input(quantity)).items[0].quantity, quantity);
});
for (const quantity of [0, -1, 1.5, 100, NaN, Infinity, "1", null]) test(`quantity ${String(quantity)} rejected`, () => {
  assert.throws(() => normalizeCreateRequest(input(quantity)), { code: "INVALID_QUANTITY" });
});
test("strict input and key validation reject ownership, money, notes and metadata injection", () => {
  for (const field of ["cashierId", "shiftId", "orderNumber", "status", "revision", "total", "note", "createRequestFingerprint"]) {
    assert.throws(() => normalizeCreateRequest({ ...input(), [field]: "injected" }), { code: "INVALID_INPUT" });
  }
  for (const field of ["productName", "price", "lineTotal", "notes"]) {
    assert.throws(() => normalizeCreateRequest({ ...input(), items: [{ productId: a, quantity: 1, [field]: 1 }] }), { code: "INVALID_INPUT" });
  }
  for (const key of [undefined, "", "bad", ` ${randomUUID()}`]) assert.throws(() => normalizeCreateRequest({ ...input(), createIdempotencyKey: key }), { code: "INVALID_IDEMPOTENCY_KEY" });
  assert.throws(() => normalizeCreateRequest({}), { code: "INVALID_IDEMPOTENCY_KEY" });
  for (const value of [null, [], { ...input(), items: [] }, { ...input(), orderType: "DELIVERY" }, { ...input(), items: [{ productId: "bad", quantity: 1 }] }]) {
    assert.throws(() => normalizeCreateRequest(value), { code: "INVALID_INPUT" });
  }
});
test("merge, UUID case and ordering yield deterministic original intent fingerprints", () => {
  const request = input();
  const first = normalizeCreateRequest({ ...request, items: [{ productId: b, quantity: 1 }, { productId: a.toUpperCase(), quantity: 1 }, { productId: a, quantity: 2 }] });
  const second = normalizeCreateRequest({ ...request, items: [{ productId: a, quantity: 3 }, { productId: b, quantity: 1 }] });
  assert.deepEqual(first, second);
  assert.equal(fingerprintCreateRequest(first), fingerprintCreateRequest(second));
  assert.match(fingerprintCreateRequest(first), /^[a-f0-9]{64}$/);
  assert.equal(fingerprintCreateRequest(first), fingerprintCreateRequest({ ...first, createIdempotencyKey: randomUUID() }));
  assert.notEqual(fingerprintCreateRequest(first), fingerprintCreateRequest({ ...first, orderType: "TAKEAWAY" }));
  assert.throws(() => normalizeCreateRequest({ ...request, items: [{ productId: a, quantity: 99 }, { productId: a, quantity: 1 }] }), { code: "INVALID_QUANTITY" });
});
test("100 unique lines accepted, 101 rejected; raw duplicate lines do not count toward limit", () => {
  const items = Array.from({ length: 100 }, () => ({ productId: randomUUID(), quantity: 1 }));
  assert.equal(normalizeCreateRequest({ ...input(), items: [...items, items[0]] }).items.length, 100);
  assert.throws(() => normalizeCreateRequest({ ...input(), items: [...items, { productId: randomUUID(), quantity: 1 }] }), { code: "TOO_MANY_ITEMS" });
});
const product = (price: number, id = a) => ({ id, name: "Coffee", price, active: true, available: true });
test("authoritative eligibility, names, prices and summed snapshots", () => {
  const items = [{ productId: a, quantity: 2 }, { productId: b, quantity: 3 }];
  const priced = priceOrder(items, [product(22000), product(5000, b)]);
  assert.equal(priced.total, 59000);
  assert.deepEqual(priced.items[0], { productId: a, productNameSnapshot: "Coffee", unitPriceSnapshot: 22000, quantity: 2, lineTotal: 44000 });
  assert.throws(() => priceOrder(items, [product(1)]), { code: "PRODUCT_NOT_FOUND" });
  for (const field of ["active", "available"]) assert.throws(() => priceOrder([items[0]], [{ ...product(1), [field]: false }]), { code: "PRODUCT_UNAVAILABLE" });
});
test("Int money boundaries and overflow checks", () => {
  for (const [price, quantity] of [[0, 99], [MAX_ORDER_MONEY, 1], [Math.floor(MAX_ORDER_MONEY / 99), 99]]) {
    assert.equal(priceOrder([{ productId: a, quantity }], [product(price)]).total, price * quantity);
  }
  for (const price of [-1, 1.5, NaN, Infinity, MAX_ORDER_MONEY + 1]) assert.throws(() => priceOrder([{ productId: a, quantity: 1 }], [product(price)]), { code: "MONEY_OVERFLOW" });
  assert.throws(() => priceOrder([{ productId: a, quantity: 2 }], [product(MAX_ORDER_MONEY)]), { code: "MONEY_OVERFLOW" });
  assert.throws(() => priceOrder([{ productId: a, quantity: 1 }, { productId: b, quantity: 1 }], [product(MAX_ORDER_MONEY), product(1, b)]), { code: "MONEY_OVERFLOW" });
});
test("sequence formatting grows naturally and allows gaps", () => {
  for (const [value, expected] of [[1, "AR-000001"], [42, "AR-000042"], [999999, "AR-999999"], [1000000, "AR-1000000"]] as const) assert.equal(formatOrderNumber(BigInt(value)), expected);
});
