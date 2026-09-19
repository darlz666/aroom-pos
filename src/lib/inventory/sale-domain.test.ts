import assert from "node:assert/strict";
import { test } from "node:test";
import { remainingStock, saleQuantity, stockDecimal } from "./sale-domain";

test("sale consumption uses exact canonical conversions and integer arithmetic", () => {
  assert.equal(stockDecimal(saleQuantity("0.120", "L", "ml", 2)), "240.000");
  assert.equal(stockDecimal(saleQuantity("0.005", "kg", "g", 2)), "10.000");
  assert.equal(stockDecimal(saleQuantity("1", "pcs", "pcs", 2)), "2.000");
  assert.equal(remainingStock("0.003", saleQuantity("0.001", "ml", "ml", 2)), "0.001");
  assert.equal(remainingStock("999999999999999.999", BigInt("999999999999999998")), "0.001");
  assert.equal(remainingStock("200", saleQuantity("150", "ml", "ml", 1)), "50.000");
  assert.throws(() => remainingStock("200", saleQuantity("150", "ml", "ml", 2)), { code: "INSUFFICIENT_STOCK" });
  // Aggregation can exceed NUMERIC/BIGINT bounds; check against stock exactly.
  assert.throws(() => remainingStock("999999999999999.999", saleQuantity("999999999999999.999", "g", "g", 2147483647)), { code: "INSUFFICIENT_STOCK" });
});

test("invalid inventory quantities and units never round or silently skip", () => {
  for (const quantity of ["0", "-1", "0.0001", "NaN", "1000000000000000"]) {
    assert.throws(() => saleQuantity(quantity, "ml", "ml", 1), { code: "INVALID_INVENTORY_STATE" });
  }
  assert.throws(() => saleQuantity("1", "g", "ml", 1), { code: "INVALID_INVENTORY_STATE" });
  assert.throws(() => saleQuantity("1", "ml", "ml", 1.5), { code: "INVALID_INVENTORY_STATE" });
  assert.throws(() => remainingStock("NaN", BigInt(1)), { code: "INVALID_INVENTORY_STATE" });
});
