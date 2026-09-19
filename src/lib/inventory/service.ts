import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type Supplier } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { InventoryError, inventoryId, inventoryObject, inventoryQuantity, supplierInput } from "./domain";
import { stockInFingerprint, stockInInput, stockInLine } from "./stock-in-domain";
import { ingredientHpp, rupiahAmount, weightedAverageCost } from "./costing";
import { withRecipeAccess } from "./recipe-authorization";

type InventoryActor = Pick<AuthenticatedUser, "id" | "role">;
function authorized<T>(db: PrismaClient, actor: InventoryActor, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    if (!actor || !["ADMIN", "STOCK_MANAGEMENT"].includes(actor.role)) throw new InventoryError("FORBIDDEN");
    const id = inventoryId(actor.id);
    // Hold authorization through commit; account changes apply to the next request.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
    const current = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!current?.active || !["ADMIN", "STOCK_MANAGEMENT"].includes(current.role)) throw new InventoryError("FORBIDDEN");
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function supplierDto(supplier: Supplier) {
  return { ...supplier, createdAt: supplier.createdAt.toISOString(), updatedAt: supplier.updatedAt.toISOString() };
}

export async function listSuppliers(db: PrismaClient, actor: InventoryActor) {
  return authorized(db, actor, async tx => (await tx.supplier.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] })).map(supplierDto));
}

export async function createSupplier(db: PrismaClient, actor: InventoryActor, input: unknown) {
  return authorized(db, actor, async tx => {
    const data = supplierInput(input);
    const supplier = await tx.supplier.create({ data });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "SUPPLIER_CREATED", entityType: "Supplier", entityId: supplier.id, details: data } });
    return supplierDto(supplier);
  });
}

/** Full metadata replacement, including explicit active state; no hard deletion. */
export async function updateSupplier(db: PrismaClient, actor: InventoryActor, input: unknown) {
  return authorized(db, actor, async tx => {
    const { supplierId, ...fields } = inventoryObject(input, ["supplierId", "name", "contact", "phone", "address", "active"]);
    const id = inventoryId(supplierId);
    if (typeof fields.active !== "boolean") throw new InventoryError("INVALID_INPUT");
    const data = supplierInput(fields);
    await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${id}::uuid FOR UPDATE`;
    const before = await tx.supplier.findUnique({ where: { id } });
    if (!before) throw new InventoryError("SUPPLIER_NOT_FOUND");
    if ((Object.keys(data) as (keyof typeof data)[]).every(key => before[key] === data[key])) return supplierDto(before);
    const supplier = await tx.supplier.update({ where: { id }, data });
    await tx.auditLog.create({ data: { actorId: actor.id, action: "SUPPLIER_UPDATED", entityType: "Supplier", entityId: id,
      details: { before: { name: before.name, contact: before.contact, phone: before.phone, address: before.address, active: before.active }, after: data } } });
    return supplierDto(supplier);
  });
}

const stockInInclude = { items: { orderBy: { ingredientId: "asc" as const } } } satisfies Prisma.StockInInclude;
function stockInDto(receipt: Prisma.StockInGetPayload<{ include: typeof stockInInclude }>) {
  return { id: receipt.id, referenceNumber: receipt.referenceNumber, supplierId: receipt.supplierId,
    supplierName: receipt.supplierNameSnapshot, actorId: receipt.actorId, notes: receipt.notes,
    receivedAt: receipt.receivedAt.toISOString(), createdAt: receipt.createdAt.toISOString(),
    items: receipt.items.map(item => ({ id: item.id, ingredientId: item.ingredientId, ingredientName: item.ingredientNameSnapshot,
      inputQuantity: item.inputQuantity.toFixed(), inputUnit: item.inputUnit, baseQuantity: item.baseQuantity.toFixed(), baseUnit: item.baseUnit,
      unitCost: item.unitCost, purchaseUnitCost: item.purchaseUnitCost,
      receivedUnitCostMicros: item.receivedUnitCostMicros?.toString() ?? null, lineTotal: item.lineTotal })),
  };
}

/** Retry an uncertain submission with the SAME key and payload, never a new key. */
export async function createStockIn(db: PrismaClient, actor: InventoryActor, input: unknown) {
  return authorized(db, actor, async tx => {
    const request = stockInInput(input);
    const fingerprint = stockInFingerprint(actor.id, request);
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
      items: { create: lines.map(({ line }) => line) },
    }, include: stockInInclude });
    for (const { line, stockAfter, weightedAverageUnitCostMicros } of lines) {
      await tx.stockMovement.create({ data: { ingredientId: line.ingredientId, type: "PURCHASE", quantity: line.baseQuantity,
        unit: line.baseUnit, stockAfter, sourceType: "StockIn", sourceId: id, actorId: actor.id } });
      await tx.ingredient.update({ where: { id: line.ingredientId }, data: { currentStock: stockAfter, weightedAverageUnitCostMicros } });
    }
    return { ...stockInDto(receipt), replayed: false };
  });
}

/** One SQL statement gives recipe quantities and all current costs one snapshot. */
export async function getRecipeHpp(db: PrismaClient, actor: InventoryActor, productId: unknown) {
  return withRecipeAccess(db, actor, false, async tx => {
    const result = await readRecipe(tx, inventoryId(productId));
    if (!result.recipeId) throw new InventoryError("RECIPE_NOT_FOUND");
    if (result.costError) throw new InventoryError(result.costError);
    return result;
  });
}

/** Recipe definition and WAC share the same statement snapshot, even while
 * receiving or another recipe edit commits. Also supports products without recipes. */
export async function readRecipe(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{
      recipeId: string | null; ingredientId: string | null; name: string | null;
      quantity: Prisma.Decimal | null; unit: string | null; cost: bigint | null;
      revision: number | null; ingredientActive: boolean | null;
      productName: string; productActive: boolean; productAvailable: boolean;
    }[]>`SELECT r.id AS "recipeId", r.revision, i.id AS "ingredientId", i.name,
      i.active AS "ingredientActive", p.name AS "productName", p.active AS "productActive", p.available AS "productAvailable",
      ri.quantity, ri.unit::text AS unit, i."weightedAverageUnitCostMicros" AS cost
      FROM "Product" p LEFT JOIN "Recipe" r ON r."productId" = p.id
      LEFT JOIN "RecipeItem" ri ON ri."recipeId" = r.id
      LEFT JOIN "Ingredient" i ON i.id = ri."ingredientId"
      WHERE p.id = ${id}::uuid ORDER BY i.id`;
    if (!rows.length) throw new InventoryError("PRODUCT_NOT_FOUND");
    let costError: "INVALID_COST" | null = null;
    const contribution = (row: typeof rows[number]) => {
      if (row.cost === null) return null;
      try { return ingredientHpp(row.quantity!.toFixed(), row.cost); }
      catch (error) {
        if (!(error instanceof InventoryError) || error.code !== "INVALID_COST") throw error;
        costError = "INVALID_COST"; return null;
      }
    };
    const items = rows.filter(row => row.ingredientId !== null).map(row => ({
      ingredientId: row.ingredientId!, ingredientName: row.name!, quantity: row.quantity!.toFixed(), unit: row.unit!,
      active: row.ingredientActive!,
      weightedAverageUnitCostMicros: row.cost?.toString() ?? null,
      hpp: contribution(row),
    }));
    const missingCostIngredientIds = items.filter(item => item.weightedAverageUnitCostMicros === null).map(item => item.ingredientId);
    let total: number | null = null;
    if (items.length > 0 && missingCostIngredientIds.length === 0 && !costError) {
      try { total = rupiahAmount(items.reduce((sum, item) => sum + BigInt(item.hpp!), BigInt(0))); }
      catch (error) {
        if (!(error instanceof InventoryError) || error.code !== "INVALID_COST") throw error;
        costError = "INVALID_COST";
      }
    }
    const available = total !== null;
    return { productId: id, recipeId: rows[0].recipeId, available, items, missingCostIngredientIds,
      revision: rows[0].revision, productName: rows[0].productName, productActive: rows[0].productActive, productAvailable: rows[0].productAvailable,
      total, costError };
}

export async function getStockIn(db: PrismaClient, actor: InventoryActor, stockInId: unknown) {
  return authorized(db, actor, async tx => {
    const receipt = await tx.stockIn.findUnique({ where: { id: inventoryId(stockInId) }, include: stockInInclude });
    if (!receipt) throw new InventoryError("STOCK_IN_NOT_FOUND");
    const creator = await tx.user.findUniqueOrThrow({ where: { id: receipt.actorId }, select: { name: true } });
    return { ...stockInDto(receipt), actorName: creator.name, total: receipt.items.reduce((sum, item) => sum + item.lineTotal, 0) };
  });
}

/** Status uses exact stored decimals. Inactive is a separate metadata flag. */
export async function listIngredients(db: PrismaClient, actor: InventoryActor) {
  return authorized(db, actor, async tx => (await tx.ingredient.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, baseUnit: true, currentStock: true, minimumStock: true, active: true, weightedAverageUnitCostMicros: true },
  })).map(row => ({ ...row, currentStock: row.currentStock.toFixed(), minimumStock: row.minimumStock.toFixed(),
    weightedAverageUnitCostMicros: row.weightedAverageUnitCostMicros?.toString() ?? null,
    stockStatus: row.currentStock.isZero() ? "EMPTY" as const : row.currentStock.lte(row.minimumStock) ? "LOW" as const : "AVAILABLE" as const,
  })));
}

export async function listStockIns(db: PrismaClient, actor: InventoryActor, input: unknown = {}) {
  return authorized(db, actor, async tx => {
    const raw = inventoryObject(input, ["cursor"]);
    const cursor = raw.cursor === undefined ? undefined : inventoryId(raw.cursor);
    const rows = await tx.stockIn.findMany({ take: 26, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, referenceNumber: true, supplierNameSnapshot: true, receivedAt: true, createdAt: true,
        actor: { select: { name: true } }, items: { select: { lineTotal: true } } },
    });
    const page = rows.slice(0, 25);
    return { entries: page.map(row => ({ id: row.id, referenceNumber: row.referenceNumber, supplierName: row.supplierNameSnapshot,
      receivedAt: row.receivedAt.toISOString(), createdAt: row.createdAt.toISOString(), actorName: row.actor.name,
      itemCount: row.items.length, total: row.items.reduce((sum, item) => sum + item.lineTotal, 0),
    })), nextCursor: rows.length > 25 ? page[page.length - 1].id : null };
  });
}
