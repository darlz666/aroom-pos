import { createHash } from "node:crypto";
import {
  InventoryError,
  inventoryId,
  inventoryObject,
  inventoryQuantity,
  inventoryUnit,
  name,
  recipeInput,
} from "./domain";

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

export function menuDeleteInput(input: unknown) {
  const raw = inventoryObject(input, ["productId", "idempotencyKey"]);
  return { productId: inventoryId(raw.productId), idempotencyKey: inventoryId(raw.idempotencyKey) };
}

export function menuDeleteFingerprint(actorId: string, input: ReturnType<typeof menuDeleteInput>) {
  return createHash("sha256").update(JSON.stringify({ actorId, productId: input.productId })).digest("hex");
}

export function menuCreateInput(input: unknown) {
  const raw = inventoryObject(input, [
    "idempotencyKey",
    "name",
    "categoryId",
    "price",
    "items",
  ]);

  const idempotencyKey = inventoryId(raw.idempotencyKey);
  const categoryId = inventoryId(raw.categoryId);
  const productName = name(raw.name);

  const price = raw.price;
  if (
    typeof price !== "number" ||
    !Number.isInteger(price) ||
    price <= 0 ||
    price > 2_147_483_647
  ) {
    throw new InventoryError("INVALID_INPUT");
  }

  if (
    !Array.isArray(raw.items) ||
    raw.items.length === 0 ||
    raw.items.length > 100
  ) {
    throw new InventoryError("INVALID_INPUT");
  }

  const seen = new Set<string>();

  const items = raw.items.map(value => {
    const item = inventoryObject(value, [
      "ingredientId",
      "quantity",
      "unit",
    ]);

    const ingredientId = inventoryId(item.ingredientId);

    if (seen.has(ingredientId)) {
      throw new InventoryError("DUPLICATE_INGREDIENT");
    }

    seen.add(ingredientId);

    const unit = inventoryUnit(item.unit);

    if (!["g", "ml", "pcs"].includes(unit)) {
      throw new InventoryError("INVALID_UNIT");
    }

    return {
      ingredientId,
      quantity: inventoryQuantity(item.quantity, true),
      unit,
    };
  });

  return {
    idempotencyKey,
    categoryId,
    name: productName,
    price,
    items: items.sort((a, b) =>
      a.ingredientId.localeCompare(b.ingredientId)
    ),
  };
}

export function menuCreateFingerprint(
  actorId: string,
  input: ReturnType<typeof menuCreateInput>
) {
  return createHash("sha256")
    .update(JSON.stringify({
      actorId,
      categoryId: input.categoryId,
      name: input.name,
      price: input.price,
      items: input.items.map(item => ({
        ingredientId: item.ingredientId,
        quantity: item.quantity.toFixed(),
        unit: item.unit,
      })),
    }))
    .digest("hex");
}
