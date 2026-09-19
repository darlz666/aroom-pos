import { createHash } from "node:crypto";
import { InventoryError, inventoryId, inventoryObject, recipeInput } from "./domain";

export function recipeSaveInput(input: unknown) {
  const raw = inventoryObject(input, ["productId", "expectedRevision", "idempotencyKey", "items"]);
  const idempotencyKey = inventoryId(raw.idempotencyKey);
  const expectedRevision = raw.expectedRevision;
  if (expectedRevision !== null && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)
    || expectedRevision < 1 || expectedRevision >= 2_147_483_647)) throw new InventoryError("INVALID_INPUT");
  if (!Array.isArray(raw.items) || raw.items.length > 100) throw new InventoryError("INVALID_INPUT");
  const recipe = recipeInput({ productId: raw.productId, items: raw.items });
  if (recipe.items.some(item => !["g", "ml", "pcs"].includes(item.unit))) throw new InventoryError("INVALID_UNIT");
  return { ...recipe, items: recipe.items.sort((a, b) => a.ingredientId.localeCompare(b.ingredientId)), expectedRevision, idempotencyKey };
}

export function recipeFingerprint(actorId: string, input: ReturnType<typeof recipeSaveInput>) {
  return createHash("sha256").update(JSON.stringify({ actorId, productId: input.productId,
    expectedRevision: input.expectedRevision,
    items: input.items.map(item => ({ ...item, quantity: item.quantity.toFixed() })),
  })).digest("hex");
}
