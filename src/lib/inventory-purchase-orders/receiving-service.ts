import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { quantityThousandths, MAX_RUPIAH } from "../inventory/costing";
import { InventoryError } from "../inventory/domain";
import { postStockIn, type PurchaseOrderPosting } from "../inventory/stock-in-posting";
import { authorize } from "./service";
import { fail, id, integer, object } from "./domain";
import { quantityString, receiptValues, receivingInput } from "./receiving-domain";

type Actor = Pick<AuthenticatedUser, "id" | "role">;
type ReceiptResult = { id: string; revision: number; status: "PARTIALLY_RECEIVED" | "RECEIVED"; stockInId: string; referenceNumber: string };
const progressInclude = { lines: { orderBy: { position: "asc" as const }, include: {
  stockInItems: { select: { ingredientId: true, baseQuantity: true, lineTotal: true } },
} } } satisfies Prisma.InventoryPurchaseOrderInclude;
type Order = Prisma.InventoryPurchaseOrderGetPayload<{ include: typeof progressInclude }>;
function progress(order: Order) {
  const lines = order.lines.map(line => {
    const received = line.stockInItems.reduce((sum, item) => sum + quantityThousandths(item.baseQuantity.toFixed()), BigInt(0));
    const remaining = quantityThousandths(line.baseQuantity.toFixed()) - received;
    if (remaining < BigInt(0)) fail("OVER_RECEIPT");
    const identities = [...new Set(line.stockInItems.map(item => item.ingredientId))];
    if (identities.length > 1) fail("INGREDIENT_UNAVAILABLE");
    return { lineId: line.id, baseUnit: line.baseUnit, orderedBaseQuantity: line.baseQuantity.toFixed(),
      receivedBaseQuantity: quantityString(received), remainingBaseQuantity: quantityString(remaining),
      resolvedIngredientId: line.ingredientId ?? identities[0] ?? null,
      actualReceivedTotal: line.stockInItems.length ? line.stockInItems.reduce((sum, item) => sum + BigInt(item.lineTotal), BigInt(0)).toString() : null };
  });
  const actuals = lines.filter(l => l.actualReceivedTotal !== null);
  return { lines, actualReceivedTotal: actuals.length ? actuals.reduce((sum, l) => sum + BigInt(l.actualReceivedTotal!), BigInt(0)).toString() : null };
}

/** Lock order: User -> PO operation key -> PO id/header -> StockIn key ->
 * Supplier -> sorted proposed names -> resolved Ingredient IDs (postStockIn).
 * Never take existing Ingredient row locks before entering the shared poster.
 * Newly inserted masters are invisible to other transactions until commit.
 */
export async function receiveInventoryPurchaseOrder(db: PrismaClient, actor: Actor, input: unknown): Promise<ReceiptResult> {
  const request = receivingInput(input);
  return db.$transaction(async tx => {
    const user = await authorize(tx, actor);
    if (user.role !== "STOCK_MANAGEMENT") fail("FORBIDDEN");
    const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: user.id, operation: "RECEIVE", ...request })).digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.key}, 941))`;
    const replay = await tx.inventoryPurchaseOrderEvent.findUnique({ where: { key: request.key } });
    if (replay) {
      if (replay.fingerprint !== fingerprint || replay.operation !== "RECEIVE") fail("IDEMPOTENCY_CONFLICT");
      return (replay.snapshot as { result: ReceiptResult }).result;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.id}, 942))`;
    await tx.$queryRaw`SELECT id FROM "InventoryPurchaseOrder" WHERE id = ${request.id}::uuid FOR UPDATE`;
    const po = await tx.inventoryPurchaseOrder.findUnique({ where: { id: request.id }, include: progressInclude });
    if (!po) fail("NOT_FOUND");
    if (po.revision !== request.revision) fail("STALE_REVISION");
    if (po.status !== "ORDERED" && po.status !== "PARTIALLY_RECEIVED") fail("INVALID_TRANSITION");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.key}, 731))`;
    await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${po.supplierId}::uuid FOR SHARE`;
    const supplier = await tx.supplier.findUnique({ where: { id: po.supplierId } });
    if (!supplier?.active) fail("SUPPLIER_UNAVAILABLE");
    const before = progress(po);
    const planned = request.lines.map(line => {
      const approved = po.lines.find(l => l.id === line.lineId);
      if (!approved) fail();
      const state = before.lines.find(l => l.lineId === line.lineId)!;
      const values = receiptValues(line, approved);
      if (quantityThousandths(values.baseQuantity) > quantityThousandths(state.remainingBaseQuantity)) fail("OVER_RECEIPT");
      if (approved.ingredientId && line.resolution) fail();
      if (!approved.ingredientId && state.resolvedIngredientId && line.resolution &&
        (line.resolution.type !== "EXISTING" || line.resolution.ingredientId !== state.resolvedIngredientId)) fail("INGREDIENT_UNAVAILABLE");
      if (!state.resolvedIngredientId && !line.resolution) fail();
      return { line, approved, state, values };
    });
    if (planned.reduce((sum, p) => sum + BigInt(p.values.actualAmount), BigInt(0)) > MAX_RUPIAH) fail();
    // PostgreSQL normalizes names exactly as the existing unique index does.
    const names = new Set<string>();
    for (const plan of planned.filter(p => !p.state.resolvedIngredientId && p.line.resolution?.type === "CREATE")) {
      const normalized = await tx.$queryRaw<{ name: string }[]>`SELECT lower(btrim(${plan.approved.proposedName!})) AS name`;
      names.add(normalized[0].name);
    }
    for (const name of [...names].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 943))`;
    const context: PurchaseOrderPosting = { id: po.id, fingerprint, lines: {} };
    const items = [];
    for (const { line, approved, state, values } of planned) {
      let ingredientId = state.resolvedIngredientId;
      if (!ingredientId) {
        if (line.resolution!.type === "EXISTING") ingredientId = line.resolution!.ingredientId;
        else {
          const matches = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Ingredient" WHERE lower(btrim(name)) = lower(btrim(${approved.proposedName!}))`;
          if (matches.length) fail("DUPLICATE_INGREDIENT");
          const created = await tx.ingredient.create({ data: { name: approved.proposedName!, baseUnit: approved.baseUnit } });
          ingredientId = created.id;
          await tx.auditLog.create({ data: { actorId: user.id, action: "INVENTORY_PO_INGREDIENT_CREATED", entityType: "InventoryPurchaseOrder", entityId: po.id,
            details: { lineId: approved.id, ingredientId, name: created.name, baseUnit: created.baseUnit } } });
        }
      }
      const master = await tx.ingredient.findUnique({ where: { id: ingredientId } });
      if (!master?.active || master.baseUnit !== approved.baseUnit) fail("INGREDIENT_UNAVAILABLE");
      // Preserve StockIn's one-item-per-ingredient contract. Distinct PO lines
      // cannot resolve to the same ingredient in a receipt or across this PO.
      if (context.lines[ingredientId] || before.lines.some(l => l.lineId !== approved.id && l.resolvedIngredientId === ingredientId)) fail("DUPLICATE_INGREDIENT");
      context.lines[ingredientId] = { purchaseOrderLineId: approved.id, approvedUnitPrice: approved.estimatedUnitPrice,
        approvedPurchaseUnit: approved.purchaseUnit, approvedEstimatedAmountMicros: values.approvedEstimatedAmountMicros,
        priceVarianceMicros: values.priceVarianceMicros, varianceReason: line.varianceReason };
      items.push({ ingredientId, quantity: line.quantity, unit: line.unit, purchaseUnitCost: line.purchaseUnitCost });
    }
    const receipt = await postStockIn(tx, user, { idempotencyKey: request.key, supplierId: po.supplierId,
      receivedAt: request.receivedAt, notes: request.notes, items }, context);
    if (receipt.replayed) fail("IDEMPOTENCY_CONFLICT"); // Receipt cannot predate its atomic PO event.
    const after = progress(await tx.inventoryPurchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: progressInclude }));
    const status = after.lines.every(l => l.remainingBaseQuantity === "0") ? "RECEIVED" : "PARTIALLY_RECEIVED";
    const saved = await tx.inventoryPurchaseOrder.update({ where: { id: po.id }, data: { status, revision: { increment: 1 } } });
    const result: ReceiptResult = { id: po.id, revision: saved.revision, status, stockInId: receipt.id, referenceNumber: receipt.referenceNumber };
    const varianceEvidence = Object.entries(context.lines).map(([ingredientId, evidence]) => ({ ...evidence, ingredientId,
      approvedEstimatedAmountMicros: evidence.approvedEstimatedAmountMicros.toString(), priceVarianceMicros: evidence.priceVarianceMicros.toString() }));
    const snapshot = { result, receipt, varianceEvidence, progress: after } as unknown as Prisma.InputJsonValue;
    await tx.inventoryPurchaseOrderEvent.create({ data: { key: request.key, fingerprint, purchaseOrderId: po.id, operation: "RECEIVE",
      fromStatus: po.status, toStatus: status, revision: saved.revision, actorId: user.id, note: request.notes, snapshot } });
    await tx.auditLog.create({ data: { actorId: user.id, action: "INVENTORY_PO_RECEIVE", entityType: "InventoryPurchaseOrder", entityId: po.id,
      details: { before, after: snapshot } as unknown as Prisma.InputJsonValue } });
    return result;
  }, { isolationLevel: "ReadCommitted", timeout: 15000 }).catch(error => {
    if (error instanceof InventoryError) {
      if (error.code === "UNKNOWN_INGREDIENT_COST") fail("UNKNOWN_INGREDIENT_COST");
      if (error.code === "IDEMPOTENCY_CONFLICT") fail("IDEMPOTENCY_CONFLICT");
      fail();
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") fail("DUPLICATE_INGREDIENT");
    throw error;
  });
}

export async function readInventoryPurchaseOrderReceipts(db: PrismaClient, actor: Actor, input: unknown) {
  const r = object(input, ["id", "page"]), orderId = id(r.id), page = integer(r.page ?? 1, 1);
  if (page > 100000) fail();
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const po = await tx.inventoryPurchaseOrder.findUnique({ where: { id: orderId }, include: progressInclude });
    if (!po) fail("NOT_FOUND");
    const rows = await tx.stockIn.findMany({ where: { purchaseOrderId: orderId }, include: { items: { orderBy: { purchaseOrderLineId: "asc" } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (page - 1) * 50, take: 51 });
    return { id: po.id, status: po.status, revision: po.revision, ...progress(po), page, hasMore: rows.length > 50,
      receipts: rows.slice(0, 50).map(row => ({ id: row.id, referenceNumber: row.referenceNumber, purchaseOrderId: row.purchaseOrderId,
        supplierId: row.supplierId, supplierName: row.supplierNameSnapshot, actorId: row.actorId, postedAt: row.createdAt.toISOString(),
        receivedAt: row.receivedAt.toISOString(), notes: row.notes, items: row.items.map(item => ({ id: item.id, lineId: item.purchaseOrderLineId,
          ingredientId: item.ingredientId, ingredientName: item.ingredientNameSnapshot, quantity: item.inputQuantity.toFixed(), unit: item.inputUnit,
          baseQuantity: item.baseQuantity.toFixed(), baseUnit: item.baseUnit, purchaseUnitCost: item.purchaseUnitCost, actualAmount: item.lineTotal,
          approvedUnitPrice: item.approvedUnitPrice, approvedPurchaseUnit: item.approvedPurchaseUnit,
          approvedEstimatedAmountMicros: item.approvedEstimatedAmountMicros?.toString() ?? null,
          priceVarianceMicros: item.priceVarianceMicros?.toString() ?? null, varianceReason: item.varianceReason })) })) };
  }, { isolationLevel: "RepeatableRead" });
}
