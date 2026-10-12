import type { InventoryUnit } from "../../generated/prisma/client";
import { inventoryQuantity, inventoryUnit, convertQuantity, InventoryError } from "../inventory/domain";
import { COST_SCALE, quantityThousandths, purchaseLineTotal } from "../inventory/costing";
import { receivedInstant } from "../inventory/stock-in-domain";
import { fail, id, integer, object, text } from "./domain";

export function receivingInput(input: unknown) {
  try {
    const r = object(input, ["id", "key", "revision", "receivedAt", "notes", "lines"]);
    const revision = integer(r.revision, 1);
    if (revision === 2147483647 || !Array.isArray(r.lines) || !r.lines.length || r.lines.length > 100) fail();
    const seen = new Set<string>();
    const lines = r.lines.map(value => {
      const line = object(value, ["lineId", "quantity", "unit", "purchaseUnitCost", "varianceReason", "resolution"]);
      const lineId = id(line.lineId);
      if (seen.has(lineId)) fail();
      seen.add(lineId);
      let resolution: { type: "CREATE" } | { type: "EXISTING"; ingredientId: string } | null = null;
      if (line.resolution !== undefined) {
        const decision = object(line.resolution, ["type", "ingredientId"]);
        if (decision.type === "CREATE") { object(decision, ["type"]); resolution = { type: "CREATE" }; }
        else if (decision.type === "EXISTING") resolution = { type: "EXISTING", ingredientId: id(decision.ingredientId) };
        else fail();
      }
      return { lineId, quantity: inventoryQuantity(line.quantity, true).toFixed(), unit: inventoryUnit(line.unit),
        purchaseUnitCost: integer(line.purchaseUnitCost), varianceReason: text(line.varianceReason, 2000, true), resolution };
    }).sort((a, b) => a.lineId.localeCompare(b.lineId));
    return { id: id(r.id), key: id(r.key), revision, receivedAt: receivedInstant(r.receivedAt).toISOString(), notes: text(r.notes, 1000, true), lines };
  } catch (error) { if (error instanceof InventoryError) fail(); throw error; }
}

/** Same quantity basis for actual and approved terms. No WAC calculation here.
 * Supported unit factors make the estimate exactly representable in micros,
 * including e.g. 1 ml at an approved Rp33,333/L = 33,333,000 micro-rupiah.
 */
export function receiptValues(line: ReturnType<typeof receivingInput>["lines"][number], approved: {
  baseUnit: InventoryUnit; purchaseUnit: InventoryUnit; estimatedUnitPrice: number;
}) {
  try {
    const baseQuantity = convertQuantity(line.quantity, line.unit, approved.baseUnit).toFixed();
    const actualAmount = purchaseLineTotal(line.quantity, BigInt(line.purchaseUnitCost) * COST_SCALE);
    const factor = approved.purchaseUnit === "kg" || approved.purchaseUnit === "L" ? BigInt(1000) : BigInt(1);
    const numerator = quantityThousandths(baseQuantity, true) * BigInt(approved.estimatedUnitPrice) * COST_SCALE;
    const denominator = BigInt(1000) * factor;
    if (numerator % denominator !== BigInt(0)) fail();
    const approvedEstimatedAmountMicros = numerator / denominator;
    const priceVarianceMicros = BigInt(actualAmount) * COST_SCALE - approvedEstimatedAmountMicros;
    if (priceVarianceMicros > BigInt(0) && !line.varianceReason) fail("VARIANCE_REASON_REQUIRED");
    return { baseQuantity, actualAmount, approvedEstimatedAmountMicros, priceVarianceMicros };
  } catch (error) { if (error instanceof InventoryError) fail(); throw error; }
}
export function quantityString(thousandths: bigint) {
  return `${thousandths / BigInt(1000)}.${(thousandths % BigInt(1000)).toString().padStart(3, "0")}`.replace(/\.?0+$/, "");
}
