import assert from "node:assert/strict";
import { test } from "node:test";
import { adjustmentInput, effectivePaidAt, financials, voidInput } from "./adjustment-domain";
const uuid = "10000000-0000-4000-8000-000000000001";
const item = { productName: " Coffee ", quantity: 2, unitSellingPrice: 22000, unitHpp: 8000 };
const input = { orderId: uuid, expectedRevision: 0, idempotencyKey: uuid, businessDate: "2026-09-28", orderNumber: " AR-1 ", channelFee: 4000, items: [item] };
test("strict inputs, normalized snapshots and merchant channel fee financial semantics", () => {
  assert.equal(adjustmentInput(input).items[0].productName, "Coffee");
  assert.equal(adjustmentInput(input).orderNumber, "AR-1");
  const example = financials([{ productName: "Coffee", quantity: 1, unitSellingPrice: 25000, unitHpp: 12950 }], 500);
  assert.deepEqual(example, { quantity: 1, sellingPrice: 25000, totalRevenue: 25000, hpp: 12950,
    channelFee: 500, totalDeductions: 500, grossProfit: 12050, netRevenue: 11550, effectiveSales: 25000 });
  const unknown = financials([{ ...item, unitHpp: null }], 500);
  assert.equal(unknown.grossProfit, null); assert.equal(unknown.netRevenue, null); assert.equal(unknown.channelFee, 500);
  assert.equal(financials([{ ...item, unitHpp: 0 }], 0).hpp, 0);
  assert.equal(adjustmentInput({ ...input, channelFee: 44001 }).channelFee, 44001);
  for (const patch of [{ actorId: uuid }, { role: "ADMIN" }, { items: [] }, { items: Array(101).fill(item) }, { orderNumber: " " }, { orderNumber: "x".repeat(101) }, { businessDate: "2026-02-29" }, { channelFee: 0.5 }])
    assert.throws(() => adjustmentInput({ ...input, ...patch }), { code: "INVALID_INPUT" });
  for (const quantity of [0, -1, 0.5, Number.MAX_SAFE_INTEGER, NaN, Infinity, "2"])
    assert.throws(() => adjustmentInput({ ...input, items: [{ ...item, quantity }] }), { code: "INVALID_INPUT" });
  for (const unitSellingPrice of [-1, 0.5, Number.MAX_SAFE_INTEGER, 2147483647])
    assert.throws(() => adjustmentInput({ ...input, items: [{ ...item, unitSellingPrice }] }), { code: "INVALID_INPUT" });
});
test("bulk void validates raw batch size, deduplicates exact targets and sorts deterministically", () => {
  const a = "20000000-0000-4000-8000-000000000001", b = "10000000-0000-4000-8000-000000000001";
  assert.throws(() => voidInput({ businessDate: input.businessDate }), { code: "INVALID_INPUT" });
  assert.throws(() => voidInput({ businessDate: input.businessDate, transactions: [] }), { code: "INVALID_INPUT" });
  const parsed = voidInput({ businessDate: input.businessDate, transactions: [
    { orderId: a, expectedRevision: 2 }, { orderId: b, expectedRevision: 0 }, { orderId: a, expectedRevision: 2 },
  ] });
  assert.deepEqual(parsed.transactions, [{ orderId: b, expectedRevision: 0 }, { orderId: a, expectedRevision: 2 }]);
  assert.throws(() => voidInput({ businessDate: input.businessDate, transactions: [
    { orderId: a, expectedRevision: 1 }, { orderId: a, expectedRevision: 2 },
  ] }), { code: "INVALID_INPUT" });
  const thousand = Array.from({ length: 1000 }, (_, index) => ({ orderId: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`, expectedRevision: 0 }));
  assert.equal(voidInput({ businessDate: input.businessDate, transactions: thousand }).transactions.length, 1000);
  assert.throws(() => voidInput({ businessDate: input.businessDate, transactions: [...thousand, thousand[0]] }), { code: "INVALID_INPUT" });
});
test("date replacement preserves original Jakarta time across midnight, leap day and repeated edits", () => {
  for (const [original, expected] of [
    ["2026-09-27T16:59:59.999Z", "2024-02-29T16:59:59.999Z"],
    ["2026-09-27T17:00:00.000Z", "2024-02-28T17:00:00.000Z"],
    ["2026-09-27T17:05:01.123Z", "2024-02-28T17:05:01.123Z"],
  ]) assert.equal(effectivePaidAt("2024-02-29", new Date(original)).toISOString(), expected);
});
