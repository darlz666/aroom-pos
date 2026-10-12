import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { jakartaBusinessDate } from "../reports/domain";
import { convertQuantity, InventoryError } from "../inventory/domain";
import { fail, id, integer, mutationInput, object, statuses, text, transition } from "./domain";

type Actor = Pick<AuthenticatedUser, "id" | "role">;
const include = { lines: { orderBy: { position: "asc" as const } } } satisfies Prisma.InventoryPurchaseOrderInclude;
type Order = Prisma.InventoryPurchaseOrderGetPayload<{ include: typeof include }>;
function dto(order: Order) {
  return { ...order, createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString(),
    submittedAt: order.submittedAt?.toISOString() ?? null, decidedAt: order.decidedAt?.toISOString() ?? null,
    orderedAt: order.orderedAt?.toISOString() ?? null,
    lines: order.lines.map(line => ({ ...line, purchaseQuantity: line.purchaseQuantity.toFixed(), baseQuantity: line.baseQuantity.toFixed() })) };
}
export async function authorize(tx: Prisma.TransactionClient, actor: Actor) {
  if (!actor?.id) fail("FORBIDDEN");
  const actorId = id(actor.id);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actorId}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, active: true } });
  if (!user?.active || !["STOCK_MANAGEMENT", "FINANCE", "ADMIN"].includes(user.role)) fail("FORBIDDEN");
  return user;
}
async function supplier(tx: Prisma.TransactionClient, supplierId: string) {
  await tx.$queryRaw`SELECT id FROM "Supplier" WHERE id = ${supplierId}::uuid FOR SHARE`;
  const row = await tx.supplier.findUnique({ where: { id: supplierId } });
  if (!row?.active) fail("SUPPLIER_UNAVAILABLE");
  return row;
}
async function ingredients(tx: Prisma.TransactionClient, ids: string[]) {
  const rows = new Map<string, { id: string; name: string; baseUnit: "g" | "ml" | "pcs" }>();
  for (const ingredientId of [...new Set(ids)].sort()) {
    await tx.$queryRaw`SELECT id FROM "Ingredient" WHERE id = ${ingredientId}::uuid FOR SHARE`;
    const row = await tx.ingredient.findUnique({ where: { id: ingredientId } });
    if (!row?.active || !["g", "ml", "pcs"].includes(row.baseUnit)) fail("INGREDIENT_UNAVAILABLE");
    rows.set(row.id, { id: row.id, name: row.name, baseUnit: row.baseUnit as "g" | "ml" | "pcs" });
  }
  return rows;
}
async function resolveDraft(tx: Prisma.TransactionClient, draft: NonNullable<ReturnType<typeof mutationInput>["data"]>) {
  const vendor = await supplier(tx, draft.supplierId);
  const masters = await ingredients(tx, draft.lines.flatMap(l => l.ingredientId ? [l.ingredientId] : []));
  const lines = [];
  for (const line of draft.lines) {
    const master = line.ingredientId ? masters.get(line.ingredientId)! : line.proposedIngredient!;
    if (!line.ingredientId) {
      // Same normalized-name rule as the existing Ingredient unique index.
      // Never fuzzy-match, create or silently replace a proposed ingredient.
      const matches = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Ingredient" WHERE lower(btrim(name)) = lower(btrim(${master.name}))`;
      if (matches.length) fail("DUPLICATE_INGREDIENT");
    }
    let baseQuantity: string;
    try { baseQuantity = convertQuantity(line.purchaseQuantity, line.purchaseUnit, master.baseUnit).toFixed(); }
    catch (error) { if (error instanceof InventoryError) fail(); throw error; }
    lines.push({ id: line.id, position: line.position, ingredientId: line.ingredientId,
      itemNameSnapshot: master.name, proposedName: line.proposedIngredient?.name ?? null,
      purchaseQuantity: line.purchaseQuantity, purchaseUnit: line.purchaseUnit, baseQuantity, baseUnit: master.baseUnit,
      estimatedUnitPrice: line.estimatedUnitPrice, estimatedTotal: line.estimatedTotal });
  }
  return { supplierId: vendor.id, supplierNameSnapshot: vendor.name, notes: draft.notes, estimatedTotal: draft.estimatedTotal, lines };
}

/** Metadata/approval only. Never calls stock posting or mutates inventory masters. */
export async function saveInventoryPurchaseOrder(db: PrismaClient, actor: Actor, input: unknown) {
  const request = mutationInput(input);
  return db.$transaction(async tx => {
    const user = await authorize(tx, actor);
    const decision = request.operation === "APPROVE" || request.operation === "REJECT";
    if (user.role !== (decision ? "FINANCE" : "STOCK_MANAGEMENT")) fail("FORBIDDEN");
    const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: user.id, ...request })).digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.key}, 941))`;
    const replay = await tx.inventoryPurchaseOrderEvent.findUnique({ where: { key: request.key } });
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
      return { id: replay.purchaseOrderId, revision: replay.revision };
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.id}, 942))`;
    await tx.$queryRaw`SELECT id FROM "InventoryPurchaseOrder" WHERE id = ${request.id}::uuid FOR UPDATE`;
    const before = await tx.inventoryPurchaseOrder.findUnique({ where: { id: request.id }, include });
    if (request.operation !== "CREATE" && !before) fail("NOT_FOUND");
    if (request.operation === "CREATE" ? !!before : before!.revision !== request.revision) fail("STALE_REVISION");
    const status = transition(user.role, request.operation, before?.status ?? null, before?.createdBy === user.id);
    const now = new Date();
    let saved: Order;
    if (request.data) {
      const { lines, ...fields } = await resolveDraft(tx, request.data);
      // Replacement is restricted to DRAFT and serialized by the parent lock.
      if (before) await tx.inventoryPurchaseOrderLine.deleteMany({ where: { purchaseOrderId: before.id } });
      saved = before ? await tx.inventoryPurchaseOrder.update({ where: { id: before.id }, data: {
        ...fields, revision: { increment: 1 }, lines: { create: lines },
      }, include }) : await tx.inventoryPurchaseOrder.create({ data: {
        ...fields, id: request.id, createdBy: user.id,
        referenceNumber: `IPO-${jakartaBusinessDate(now).replaceAll("-", "")}-${randomUUID()}`, lines: { create: lines },
      }, include });
    } else {
      // Recheck eligibility at submission/order without changing approved snapshots.
      if (request.operation === "SUBMIT" || request.operation === "ORDER") {
        await supplier(tx, before!.supplierId);
        await ingredients(tx, before!.lines.flatMap(l => l.ingredientId ? [l.ingredientId] : []));
      }
      saved = await tx.inventoryPurchaseOrder.update({ where: { id: request.id }, data: {
        status, revision: { increment: 1 },
        ...(request.operation === "SUBMIT" ? { submittedAt: now } : {}),
        ...(decision ? { decidedBy: user.id, decidedAt: now, decisionNote: request.note } : {}),
        ...(request.operation === "ORDER" ? { orderedAt: now } : {}),
      }, include });
    }
    const snapshot = dto(saved) as unknown as Prisma.InputJsonValue;
    await tx.inventoryPurchaseOrderEvent.create({ data: { key: request.key, fingerprint, purchaseOrderId: saved.id,
      operation: request.operation, fromStatus: before?.status ?? null, toStatus: saved.status,
      revision: saved.revision, actorId: user.id, note: request.note, snapshot } });
    await tx.auditLog.create({ data: { actorId: user.id, action: `INVENTORY_PO_${request.operation}`,
      entityType: "InventoryPurchaseOrder", entityId: saved.id,
      details: { before: before ? dto(before) : null, after: snapshot } as Prisma.InputJsonValue } });
    return { id: saved.id, revision: saved.revision };
  }, { isolationLevel: "ReadCommitted" }).catch(error => {
    // A conflicting line identity or invalid foreign key is a definite rejected
    // transaction, not an uncertain network response requiring endless replay.
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003"].includes(error.code)) fail();
    throw error;
  });
}

export async function listInventoryPurchaseOrders(db: PrismaClient, actor: Actor, input: unknown = {}) {
  const r = object(input, ["page", "status", "supplierId", "search"]);
  const page = integer(r.page ?? 1, 1);
  if (page > 100000 || (r.status !== undefined && !statuses.includes(r.status as typeof statuses[number]))) fail();
  const search = text(r.search, 128, true);
  const where: Prisma.InventoryPurchaseOrderWhereInput = {
    ...(r.status === undefined ? {} : { status: r.status as typeof statuses[number] }),
    ...(r.supplierId === undefined ? {} : { supplierId: id(r.supplierId) }),
    ...(search ? { OR: [{ referenceNumber: { contains: search, mode: "insensitive" } }, { supplierNameSnapshot: { contains: search, mode: "insensitive" } }] } : {}),
  };
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const rows = await tx.inventoryPurchaseOrder.findMany({ where, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 51 });
    return { rows: rows.slice(0, 50).map(dto), hasMore: rows.length > 50, page };
  }, { isolationLevel: "RepeatableRead" });
}
export async function getInventoryPurchaseOrder(db: PrismaClient, actor: Actor, input: unknown) {
  const orderId = id(object(input, ["id"]).id);
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const row = await tx.inventoryPurchaseOrder.findUnique({ where: { id: orderId }, include });
    if (!row) fail("NOT_FOUND");
    return dto(row);
  }, { isolationLevel: "RepeatableRead" });
}
export async function readInventoryPurchaseOrderHistory(db: PrismaClient, actor: Actor, input: unknown) {
  const r = object(input, ["id", "page"]), orderId = id(r.id), page = integer(r.page ?? 1, 1);
  if (page > 100000) fail();
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    if (!await tx.inventoryPurchaseOrder.findUnique({ where: { id: orderId }, select: { id: true } })) fail("NOT_FOUND");
    const rows = await tx.inventoryPurchaseOrderEvent.findMany({ where: { purchaseOrderId: orderId }, orderBy: { revision: "asc" },
      skip: (page - 1) * 50, take: 51, select: { operation: true, fromStatus: true, toStatus: true, revision: true, actorId: true, note: true, snapshot: true, createdAt: true } });
    return { rows: rows.slice(0, 50).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), hasMore: rows.length > 50, page };
  }, { isolationLevel: "RepeatableRead" });
}
