import { Prisma, type Ingredient, type InventoryUnit, type Product } from "../../generated/prisma/client";

export class InventoryError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "INVALID_ID" | "INVALID_UNIT" | "INCOMPATIBLE_UNIT" | "INVALID_QUANTITY" | "DUPLICATE_INGREDIENT" | "INGREDIENT_NOT_FOUND" | "PRODUCT_NOT_FOUND" | "FORBIDDEN" | "SUPPLIER_NOT_FOUND" | "SUPPLIER_INACTIVE" | "INGREDIENT_INACTIVE" | "STOCK_IN_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "INVALID_COST" | "UNKNOWN_INGREDIENT_COST" | "RECIPE_NOT_FOUND" | "STALE_RECIPE") {
    super(code);
    this.name = "InventoryError";
  }
}

export const inventoryUnits = ["g", "kg", "ml", "L", "pcs"] as const satisfies readonly InventoryUnit[];
export type BaseUnit = "g" | "ml" | "pcs";
const conversions = {
  g: { unit: "g", factor: 1 }, kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 }, L: { unit: "ml", factor: 1000 },
  pcs: { unit: "pcs", factor: 1 },
} as const;
const maxQuantity = new Prisma.Decimal("999999999999999.999");

export function inventoryObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new InventoryError("INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}

export function inventoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new InventoryError("INVALID_ID");
  return value.toLowerCase();
}

export function inventoryUnit(value: unknown): InventoryUnit {
  if (!inventoryUnits.some(unit => unit === value)) throw new InventoryError("INVALID_UNIT");
  return value as InventoryUnit;
}

export function canonicalUnit(value: unknown): BaseUnit {
  return conversions[inventoryUnit(value)].unit;
}

/** Exact decimals only, bounded to NUMERIC(18,3); never round or clamp inputs. */
export function inventoryQuantity(value: unknown, positive = false): Prisma.Decimal {
  if (typeof value !== "string" && typeof value !== "number") throw new InventoryError("INVALID_QUANTITY");
  const text = String(value);
  if (text.length > 32 || !/^\d+(\.\d+)?$/.test(text)) throw new InventoryError("INVALID_QUANTITY");
  const quantity = new Prisma.Decimal(text);
  if (!quantity.isFinite() || quantity.lt(0) || (positive && quantity.isZero()) || quantity.gt(maxQuantity) || quantity.decimalPlaces() > 3) {
    throw new InventoryError("INVALID_QUANTITY");
  }
  return quantity;
}

/** Integer rupiah per one canonical base unit; null means cost is unknown. */
export function ingredientUnitCost(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) throw new InventoryError("INVALID_INPUT");
  return value;
}

/** Only kg/g and L/ml conversions. No package sizes, densities or custom units. */
export function convertQuantity(value: unknown, from: unknown, to: unknown): Prisma.Decimal {
  const source = conversions[inventoryUnit(from)];
  const target = conversions[inventoryUnit(to)];
  if (source.unit !== target.unit) throw new InventoryError("INCOMPATIBLE_UNIT");
  const result = inventoryQuantity(value).mul(source.factor).div(target.factor);
  return inventoryQuantity(result.toFixed());
}

export function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new InventoryError("INVALID_INPUT");
  return value.trim();
}

function active(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new InventoryError("INVALID_INPUT");
  return value;
}

/** Metadata only: the server initializes stock to zero. Client balances/costs
 * are rejected; future transaction services will own stock and costing writes. */
export function ingredientInput(input: unknown) {
  const raw = inventoryObject(input, ["name", "baseUnit", "minimumStock", "active"]);
  const ingredientName = name(raw.name);
  const baseUnit = canonicalUnit(raw.baseUnit);
  return {
    name: ingredientName, baseUnit,
    minimumStock: convertQuantity(raw.minimumStock === undefined ? 0 : raw.minimumStock, raw.baseUnit, baseUnit),
    active: active(raw.active),
  };
}

export function optionalInventoryText(value: unknown, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > limit) throw new InventoryError("INVALID_INPUT");
  return value.trim() || null;
}

export function supplierInput(input: unknown) {
  const raw = inventoryObject(input, ["name", "contact", "phone", "address", "active"]);
  return {
    name: name(raw.name), contact: optionalInventoryText(raw.contact, 128),
    phone: optionalInventoryText(raw.phone, 64), address: optionalInventoryText(raw.address, 1000),
    active: active(raw.active),
  };
}

export function recipeInput(input: unknown) {
  const raw = inventoryObject(input, ["productId", "items"]);
  const productId = inventoryId(raw.productId);
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new InventoryError("INVALID_INPUT");
  const seen = new Set<string>();
  const items = raw.items.map(value => {
    const item = inventoryObject(value, ["ingredientId", "quantity", "unit"]);
    const ingredientId = inventoryId(item.ingredientId);
    if (seen.has(ingredientId)) throw new InventoryError("DUPLICATE_INGREDIENT");
    seen.add(ingredientId);
    return { ingredientId, quantity: inventoryQuantity(item.quantity, true), unit: inventoryUnit(item.unit) };
  });
  return { productId, items };
}

/** Supply Product/Ingredient rows read by trusted server code from the database,
 * never client-provided reference objects. This does not write or consume stock. */
export function validateRecipeReferences(
  request: ReturnType<typeof recipeInput>,
  product: Pick<Product, "id"> | null,
  ingredients: Pick<Ingredient, "id" | "baseUnit">[],
) {
  if (!product || product.id !== request.productId) throw new InventoryError("PRODUCT_NOT_FOUND");
  const byId = new Map(ingredients.map(ingredient => [ingredient.id, ingredient]));
  return {
    productId: request.productId,
    items: request.items.map(item => {
      const ingredient = byId.get(item.ingredientId);
      if (!ingredient) throw new InventoryError("INGREDIENT_NOT_FOUND");
      return { ingredientId: ingredient.id, unit: ingredient.baseUnit,
        quantity: convertQuantity(item.quantity.toFixed(), item.unit, ingredient.baseUnit) };
    }),
  };
}
