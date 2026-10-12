import type { InventoryPurchaseOrderStatus, UserRole } from "../../generated/prisma/client";
import { convertQuantity, inventoryId, inventoryQuantity, inventoryUnit, InventoryError } from "../inventory/domain";
import { COST_SCALE, purchaseLineTotal } from "../inventory/costing";

export class InventoryPurchaseOrderError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "FORBIDDEN" | "INVALID_TRANSITION" | "STALE_REVISION" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "SUPPLIER_UNAVAILABLE" | "INGREDIENT_UNAVAILABLE" | "DUPLICATE_INGREDIENT" | "OVER_RECEIPT" | "VARIANCE_REASON_REQUIRED" | "UNKNOWN_INGREDIENT_COST") {
    super(code); this.name = "InventoryPurchaseOrderError";
  }
}
export const statuses = ["DRAFT", "WAITING_APPROVAL", "APPROVED", "REJECTED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED"] as const;
export const operations = ["CREATE", "EDIT", "SUBMIT", "APPROVE", "REJECT", "ORDER"] as const;
export type Operation = typeof operations[number];
export function fail(code: ConstructorParameters<typeof InventoryPurchaseOrderError>[0] = "INVALID_INPUT"): never { throw new InventoryPurchaseOrderError(code); }
export function object(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) fail();
  return input as Record<string, unknown>;
}
export function text(value: unknown, max: number, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail();
  return value.trim();
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > 2147483647) fail();
  return value;
}
export function id(value: unknown) { try { return inventoryId(value); } catch { return fail(); } }
export function draftInput(input: unknown) {
  try {
    const raw = object(input, ["supplierId", "notes", "lines"]);
    if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 100) fail();
    const ids = new Set<string>(), ingredients = new Set<string>(), names = new Set<string>();
    const lines = raw.lines.map((value, position) => {
      const r = object(value, ["id", "ingredientId", "proposedIngredient", "purchaseQuantity", "purchaseUnit", "estimatedUnitPrice"]);
      const lineId = id(r.id);
      if (ids.has(lineId)) fail();
      ids.add(lineId);
      if ((r.ingredientId !== undefined) === (r.proposedIngredient !== undefined)) fail();
      const ingredientId = r.ingredientId === undefined ? null : id(r.ingredientId);
      let proposedIngredient: { name: string; baseUnit: "g" | "ml" | "pcs" } | null = null;
      if (ingredientId) {
        if (ingredients.has(ingredientId)) fail("DUPLICATE_INGREDIENT");
        ingredients.add(ingredientId);
      } else {
        const proposed = object(r.proposedIngredient, ["name", "baseUnit"]);
        if (!["g", "ml", "pcs"].includes(proposed.baseUnit as string)) fail();
        const name = text(proposed.name, 128)!;
        if (names.has(name.toLowerCase())) fail("DUPLICATE_INGREDIENT");
        names.add(name.toLowerCase());
        proposedIngredient = { name, baseUnit: proposed.baseUnit as "g" | "ml" | "pcs" };
      }
      const purchaseQuantity = inventoryQuantity(r.purchaseQuantity, true).toFixed();
      const purchaseUnit = inventoryUnit(r.purchaseUnit);
      if (proposedIngredient) convertQuantity(purchaseQuantity, purchaseUnit, proposedIngredient.baseUnit);
      const estimatedUnitPrice = integer(r.estimatedUnitPrice);
      const estimatedTotal = purchaseLineTotal(purchaseQuantity, BigInt(estimatedUnitPrice) * COST_SCALE);
      return { id: lineId, position, ingredientId, proposedIngredient, purchaseQuantity, purchaseUnit, estimatedUnitPrice, estimatedTotal };
    });
    const sum = lines.reduce((sum, line) => sum + BigInt(line.estimatedTotal), BigInt(0));
    if (sum > BigInt(2147483647)) fail();
    return { supplierId: id(raw.supplierId), notes: text(raw.notes, 2000, true), lines, estimatedTotal: Number(sum) };
  } catch (error) { if (error instanceof InventoryError) fail(); throw error; }
}
export function mutationInput(input: unknown) {
  const r = object(input, ["id", "key", "revision", "operation", "data", "note"]);
  const operation = operations.find(o => o === r.operation) ?? fail();
  const draft = operation === "CREATE" || operation === "EDIT";
  object(r, ["id", "key", "revision", "operation", ...(draft ? ["data"] : ["note"])]);
  const revision = integer(r.revision);
  if (revision === 2147483647 || (operation === "CREATE" ? revision !== 0 : revision < 1)) fail();
  return { id: id(r.id), key: id(r.key), revision, operation, data: draft ? draftInput(r.data) : null,
    note: text(r.note, 2000, operation !== "REJECT") };
}
export function transition(role: UserRole, operation: Operation, status: InventoryPurchaseOrderStatus | null, own = false): InventoryPurchaseOrderStatus {
  const decision = operation === "APPROVE" || operation === "REJECT";
  if (role !== (decision ? "FINANCE" : "STOCK_MANAGEMENT") || (decision && own)) fail("FORBIDDEN");
  if (operation === "CREATE" && status === null) return "DRAFT";
  if (operation === "EDIT" && status === "DRAFT") return "DRAFT";
  if (operation === "SUBMIT" && status === "DRAFT") return "WAITING_APPROVAL";
  if (operation === "APPROVE" && status === "WAITING_APPROVAL") return "APPROVED";
  if (operation === "REJECT" && status === "WAITING_APPROVAL") return "REJECTED";
  if (operation === "ORDER" && status === "APPROVED") return "ORDERED";
  return fail("INVALID_TRANSITION");
}
