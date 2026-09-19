import { convertQuantity, inventoryQuantity, type BaseUnit } from "./domain";
import { quantityThousandths } from "./costing";

export type SaleStockErrorCode = "RECIPE_NOT_CONFIGURED" | "RECIPE_INGREDIENT_INACTIVE" | "INSUFFICIENT_STOCK" | "INVALID_INVENTORY_STATE" | "INVENTORY_CONFLICT";
export class SaleStockError extends Error {
  constructor(public readonly code: SaleStockErrorCode) { super(code); this.name = "SaleStockError"; }
}

/** Exact integer thousandths throughout multiplication, aggregation and subtraction. */
export function saleQuantity(quantity: string, unit: string, baseUnit: BaseUnit, count: number): bigint {
  try {
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Invalid count");
    return quantityThousandths(convertQuantity(quantity, unit, baseUnit).toFixed(), true) * BigInt(count);
  } catch { throw new SaleStockError("INVALID_INVENTORY_STATE"); }
}

export function stockDecimal(thousandths: bigint): string {
  try {
    if (thousandths < BigInt(0)) throw new Error("Negative quantity");
    return inventoryQuantity(`${thousandths / BigInt(1000)}.${(thousandths % BigInt(1000)).toString().padStart(3, "0")}`).toFixed(3);
  } catch { throw new SaleStockError("INVALID_INVENTORY_STATE"); }
}

export function remainingStock(current: string, consumed: bigint): string {
  let balance: bigint;
  try { balance = quantityThousandths(current); }
  catch { throw new SaleStockError("INVALID_INVENTORY_STATE"); }
  if (consumed <= BigInt(0)) throw new SaleStockError("INVALID_INVENTORY_STATE");
  if (balance < consumed) throw new SaleStockError("INSUFFICIENT_STOCK");
  return stockDecimal(balance - consumed);
}
