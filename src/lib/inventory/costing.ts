import { InventoryError, inventoryQuantity } from "./domain";

export const COST_SCALE = BigInt(1_000_000);
const QUANTITY_SCALE = BigInt(1000);
export const MAX_RUPIAH = BigInt(2_147_483_647);
export const MAX_COST_MICROS = MAX_RUPIAH * COST_SCALE;

/** Nonnegative exact integer division with ties rounded upward. */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < BigInt(0) || denominator <= BigInt(0)) throw new InventoryError("INVALID_COST");
  return numerator / denominator + (BigInt(2) * (numerator % denominator) >= denominator ? BigInt(1) : BigInt(0));
}

export function quantityThousandths(value: string, positive = false): bigint {
  return BigInt(inventoryQuantity(value, positive).toFixed(3).replace(".", ""));
}

export function costMicros(value: bigint): bigint {
  if (value < BigInt(0) || value > MAX_COST_MICROS) throw new InventoryError("INVALID_COST");
  return value;
}

/** Uses the locked ingredient's current balance/cost, never latest purchase price. */
export function weightedAverageCost(stock: string, previous: bigint | null, received: string, incoming: bigint): bigint {
  const oldQuantity = quantityThousandths(stock);
  const receivedQuantity = quantityThousandths(received, true);
  costMicros(incoming);
  if (oldQuantity === BigInt(0)) return incoming;
  if (previous === null) throw new InventoryError("UNKNOWN_INGREDIENT_COST");
  return costMicros(roundHalfUp(oldQuantity * costMicros(previous) + receivedQuantity * incoming, oldQuantity + receivedQuantity));
}

/** Round each contribution once to whole rupiah; total is the sum of those lines. */
export function ingredientHpp(quantity: string, wac: bigint): number {
  return rupiahAmount(roundHalfUp(quantityThousandths(quantity, true) * costMicros(wac), QUANTITY_SCALE * COST_SCALE));
}

export function rupiahAmount(value: bigint): number {
  if (value < BigInt(0) || value > MAX_RUPIAH) throw new InventoryError("INVALID_COST");
  return Number(value); // Only bounded final whole rupiah crosses this boundary.
}

export function purchaseLineTotal(quantity: string, receivedCost: bigint): number {
  const numerator = quantityThousandths(quantity, true) * costMicros(receivedCost);
  const denominator = QUANTITY_SCALE * COST_SCALE;
  if (numerator % denominator !== BigInt(0)) throw new InventoryError("INVALID_COST");
  return rupiahAmount(numerator / denominator);
}
