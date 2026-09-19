import { createHash } from "node:crypto";
import type { Ingredient } from "../../generated/prisma/client";
import { convertQuantity, ingredientUnitCost, InventoryError, inventoryId, inventoryObject, inventoryQuantity, inventoryUnit, optionalInventoryText } from "./domain";
import { COST_SCALE, purchaseLineTotal } from "./costing";

function receivedInstant(value: unknown): Date {
  // Require an explicit offset: tablet/server timezone must never reinterpret dates.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new InventoryError("INVALID_INPUT");
  const date = new Date(value);
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) throw new InventoryError("INVALID_INPUT");
  return date;
}

export function stockInInput(input: unknown) {
  const raw = inventoryObject(input, ["idempotencyKey", "supplierId", "receivedAt", "notes", "items"]);
  const idempotencyKey = inventoryId(raw.idempotencyKey);
  const supplierId = inventoryId(raw.supplierId);
  const receivedAt = receivedInstant(raw.receivedAt);
  const notes = optionalInventoryText(raw.notes, 1000);
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 100) throw new InventoryError("INVALID_INPUT");
  const seen = new Set<string>();
  const items = raw.items.map(value => {
    const item = inventoryObject(value, ["ingredientId", "quantity", "unit", "unitCost", "purchaseUnitCost"]);
    const ingredientId = inventoryId(item.ingredientId);
    if (seen.has(ingredientId)) throw new InventoryError("DUPLICATE_INGREDIENT");
    seen.add(ingredientId);
    // Mutually exclusive contracts: legacy canonical-unit cost or purchase-unit v1.
    if (("unitCost" in item) === ("purchaseUnitCost" in item)) throw new InventoryError("INVALID_COST");
    const price = ingredientUnitCost("purchaseUnitCost" in item ? item.purchaseUnitCost : item.unitCost);
    if (price === null) throw new InventoryError("INVALID_COST");
    const common = { ingredientId, quantity: inventoryQuantity(item.quantity, true), unit: inventoryUnit(item.unit) };
    // Preserve legacy property order/shape, hence persisted request fingerprints.
    return "purchaseUnitCost" in item ? { ...common, purchaseUnitCost: price } : { ...common, unitCost: price };
  }).sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
  return { idempotencyKey, supplierId, receivedAt, notes, items };
}

export function stockInFingerprint(actorId: string, request: ReturnType<typeof stockInInput>): string {
  return createHash("sha256").update(JSON.stringify({ actorId, supplierId: request.supplierId,
    receivedAt: request.receivedAt.toISOString(), notes: request.notes,
    items: request.items.map(item => ({ ...item, quantity: item.quantity.toFixed() })),
  })).digest("hex");
}

/** Compute money with integer arithmetic, rejecting fractional rupiah/Int overflow. */
export function stockInLine(item: ReturnType<typeof stockInInput>["items"][number], ingredient: Pick<Ingredient, "id" | "name" | "baseUnit" | "active">) {
  if (ingredient.id !== item.ingredientId) throw new InventoryError("INGREDIENT_NOT_FOUND");
  if (!ingredient.active) throw new InventoryError("INGREDIENT_INACTIVE");
  const baseQuantity = convertQuantity(item.quantity.toFixed(), item.unit, ingredient.baseUnit);
  const factor = item.unit === "kg" || item.unit === "L" ? BigInt(1000) : BigInt(1);
  const purchaseUnitCost = "purchaseUnitCost" in item ? item.purchaseUnitCost : null;
  const unitCost = "unitCost" in item ? item.unitCost : null;
  const receivedUnitCostMicros = purchaseUnitCost !== null
    ? BigInt(purchaseUnitCost) * COST_SCALE / factor : BigInt(unitCost!) * COST_SCALE;
  return { ingredientId: ingredient.id, ingredientNameSnapshot: ingredient.name,
    inputQuantity: item.quantity, inputUnit: item.unit, baseQuantity, baseUnit: ingredient.baseUnit,
    unitCost, purchaseUnitCost,
    receivedUnitCostMicros, lineTotal: purchaseLineTotal(baseQuantity.toFixed(), receivedUnitCostMicros) };
}
