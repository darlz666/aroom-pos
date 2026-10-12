import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { InventoryUnit, Prisma } from "../../generated/prisma/client";
import { authorizeInventory, type InventoryActor } from "./authorization";
import { InventoryError, inventoryQuantity } from "./domain";
import { stockInFingerprint, stockInInput, stockInLine } from "./stock-in-domain";
import { weightedAverageCost } from "./costing";

export const stockInInclude = { items: { orderBy: { ingredientId: "asc" as const } } } satisfies Prisma.StockInInclude;
export function stockInDto(receipt: Prisma.StockInGetPayload<{ include: typeof stockInInclude }>) {
  return { id: receipt.id, referenceNumber: receipt.referenceNumber, supplierId: receipt.supplierId,
    supplierName: receipt.supplierNameSnapshot, actorId: receipt.actorId, notes: receipt.notes,
    receivedAt: receipt.receivedAt.toISOString(), createdAt: receipt.createdAt.toISOString(),
    items: receipt.items.map(item => ({ id: item.id, ingredientId: item.ingredientId, ingredientName: item.ingredientNameSnapshot,
      inputQuantity: item.inputQuantity.toFixed(), inputUnit: item.inputUnit, baseQuantity: item.baseQuantity.toFixed(), baseUnit: item.baseUnit,
      unitCost: item.unitCost, purchaseUnitCost: item.purchaseUnitCost,
      receivedUnitCostMicros: item.receivedUnitCostMicros?.toString() ?? null, lineTotal: item.lineTotal })),
  };
}

/** Internal posting boundary: caller owns ONE ReadCommitted transaction and
 * must propagate every failure so receipt, inventory and caller-owned writes
 * roll back together. Never expose this helper as a Server Action.
 *
 * Rechecks inventory authorization itself. A PO caller must additionally
 * enforce its stricter role/state/revision rules in the same transaction.
 * Locks: User -> receipt key -> Supplier -> Ingredient IDs in sorted order.
 * Preserve the original payload/fingerprint; replay precedes master validation.
 * A returned DTO is not durable until the caller's transaction commits.
 */
export type PurchaseOrderPosting = {
  id: string;
  fingerprint: string;
  // Trusted server-calculated evidence keyed by resolved Ingredient ID.
  lines: Record<string, { purchaseOrderLineId: string; approvedUnitPrice: number; approvedPurchaseUnit: InventoryUnit;
    approvedEstimatedAmountMicros: bigint; priceVarianceMicros: bigint; varianceReason: string | null }>;
};
export async function postStockIn(tx: Prisma.TransactionClient, actor: InventoryActor, input: unknown, purchaseOrder?: PurchaseOrderPosting) {
  await authorizeInventory(tx, actor);
  if (purchaseOrder) {
    const current = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true } });
    if (current?.role !== "STOCK_MANAGEMENT") throw new InventoryError("FORBIDDEN");
  }
  const request = stockInInput(input);
  const manualFingerprint = stockInFingerprint(actor.id, request);
  const fingerprint = purchaseOrder ? createHash("sha256").update(JSON.stringify({ domain: "InventoryPOReceipt", id: purchaseOrder.id,
    intent: purchaseOrder.fingerprint, stockIn: manualFingerprint })).digest("hex") : manualFingerprint;
  if (purchaseOrder && (Object.keys(purchaseOrder.lines).length !== request.items.length ||
    request.items.some(item => !purchaseOrder.lines[item.ingredientId]))) throw new InventoryError("INVALID_INPUT");
  // Serialize requests for this key before looking for a committed result.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.idempotencyKey}, 731))`;
  const existing = await tx.stockIn.findUnique({ where: { idempotencyKey: request.idempotencyKey }, include: stockInInclude });
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) throw new InventoryError("IDEMPOTENCY_CONFLICT");
    return { ...stockInDto(existing), replayed: true };
  }
  await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${request.supplierId}::uuid FOR SHARE`;
  const supplier = await tx.supplier.findUnique({ where: { id: request.supplierId } });
  if (!supplier) throw new InventoryError("SUPPLIER_NOT_FOUND");
  if (!supplier.active) throw new InventoryError("SUPPLIER_INACTIVE");
  // All receipts acquire shared ingredients in ID order, avoiding lost updates
  // and opposite-order deadlocks. Supplier metadata cannot change mid-receipt.
  const lines = [];
  for (const item of request.items) {
    await tx.$queryRaw`SELECT id FROM "Ingredient" WHERE id = ${item.ingredientId}::uuid FOR UPDATE`;
    const ingredient = await tx.ingredient.findUnique({ where: { id: item.ingredientId } });
    if (!ingredient) throw new InventoryError("INGREDIENT_NOT_FOUND");
    const line = stockInLine(item, ingredient);
    const stockAfter = inventoryQuantity(ingredient.currentStock.plus(line.baseQuantity).toFixed());
    const weightedAverageUnitCostMicros = weightedAverageCost(ingredient.currentStock.toFixed(),
      ingredient.weightedAverageUnitCostMicros, line.baseQuantity.toFixed(), line.receivedUnitCostMicros);
    lines.push({ line, stockAfter, weightedAverageUnitCostMicros });
  }
  const id = randomUUID();
  const receipt = await tx.stockIn.create({ data: { id, referenceNumber: `SI-${id}`, idempotencyKey: request.idempotencyKey,
    requestFingerprint: fingerprint, supplierId: supplier.id, supplierNameSnapshot: supplier.name,
    receivedAt: request.receivedAt, actorId: actor.id, notes: request.notes,
    ...(purchaseOrder ? { purchaseOrderId: purchaseOrder.id } : {}),
    items: { create: lines.map(({ line }) => ({ ...line, ...(purchaseOrder?.lines[line.ingredientId] ?? {}) })) },
  }, include: stockInInclude });
  for (const { line, stockAfter, weightedAverageUnitCostMicros } of lines) {
    await tx.stockMovement.create({ data: { ingredientId: line.ingredientId, type: "PURCHASE", quantity: line.baseQuantity,
      unit: line.baseUnit, stockAfter, sourceType: "StockIn", sourceId: id, actorId: actor.id } });
    await tx.ingredient.update({ where: { id: line.ingredientId }, data: { currentStock: stockAfter, weightedAverageUnitCostMicros } });
  }
  return { ...stockInDto(receipt), replayed: false };
}
