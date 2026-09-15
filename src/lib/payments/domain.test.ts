import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertPayable, authoritativeAmount, normalizePaymentRequest, paymentDetails, paymentFingerprint } from "./domain";

const input = { orderId: randomUUID(), expectedRevision: 1, attemptIdentifier: randomUUID(), method: "CASH", cashReceived: 30000 };
test("strict payment input rejects client money, identity, QRIS and invalid rupiah", () => {
  for (const bad of [null, [], { ...input, total: 1 }, { ...input, amount: 1 }, { ...input, actorId: randomUUID() },
    { ...input, method: "MIDTRANS_QRIS" }, { ...input, expectedRevision: 0 }, { ...input, expectedRevision: 1.5 },
    { ...input, attemptIdentifier: "bad" }, ...[-1, 1.5, NaN, Infinity, 2147483648, "30000"].map(cashReceived => ({ ...input, cashReceived }))]) {
    assert.throws(() => normalizePaymentRequest(bad), { code: "INVALID_INPUT" });
  }
  const request = normalizePaymentRequest(input);
  assert.deepEqual(paymentDetails(request, 22000), { cashReceived: 30000, changeAmount: 8000, edcReference: null });
  assert.throws(() => paymentDetails(request, 40000), { code: "INSUFFICIENT_CASH" });
  const edc = normalizePaymentRequest({ orderId: input.orderId, expectedRevision: 1, attemptIdentifier: input.attemptIdentifier, method: "BCA_EDC", edcReference: " approved " });
  assert.deepEqual(paymentDetails(edc, 22000), { cashReceived: null, changeAmount: null, edcReference: "approved" });
  assert.notEqual(paymentFingerprint("a", request), paymentFingerprint("b", request));
});
test("only current UNPAID orders without unresolved payment can be paid", () => {
  for (const status of ["PAID", "CANCELLED"]) assert.throws(() => assertPayable({ status, revision: 1 }, 1, []), { code: "ORDER_NOT_PAYABLE" });
  assert.throws(() => assertPayable({ status: "UNPAID", revision: 2 }, 1, []), { code: "REVISION_CONFLICT" });
  for (const status of ["PENDING", "SUCCEEDED"]) assert.throws(() => assertPayable({ status: "UNPAID", revision: 1 }, 1, [{ status }]), { code: "PAYMENT_BLOCKED" });
  assertPayable({ status: "UNPAID", revision: 1 }, 1, ["FAILED", "EXPIRED", "CANCELLED"].map(status => ({ status })));
});
test("amount validates saved snapshots and current menu without repricing", () => {
  const item = { unitPriceSnapshot: 22000, quantity: 2, lineTotal: 44000, product: { price: 22000, active: true, available: true } };
  assert.equal(authoritativeAmount({ total: 44000, items: [item] }), 44000);
  for (const order of [{ total: 1, items: [item] }, { total: 0, items: [] }, { total: 44000, items: [{ ...item, lineTotal: 1 }] }]) assert.throws(() => authoritativeAmount(order), { code: "INVALID_ORDER_TOTAL" });
  assert.throws(() => authoritativeAmount({ total: 44000, items: [{ ...item, product: { ...item.product, price: 23000 } }] }), { code: "PRICE_CHANGED" });
  assert.throws(() => authoritativeAmount({ total: 44000, items: [{ ...item, product: { ...item.product, available: false } }] }), { code: "PRODUCT_UNAVAILABLE" });
});
