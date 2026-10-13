import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { categoryId, categoryInput, CategoryError, type CategoryRow } from "./domain";

type Actor = { id: string; role: string };
const select = { id: true, name: true, displayOrder: true, active: true, revision: true } as const;
async function authorize(tx: Prisma.TransactionClient, actor: Actor) {
  if (!actor || actor.role !== "ADMIN") throw new CategoryError("FORBIDDEN");
  const id = categoryId(actor.id);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id }, select: { active: true, role: true } });
  if (!user?.active || user.role !== "ADMIN") throw new CategoryError("FORBIDDEN");
}
export function listCategories(db: PrismaClient, actor: Actor) {
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    return tx.category.findMany({ select, orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }] });
  });
}
export function categoryHistory(db: PrismaClient, actor: Actor, id: unknown) {
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    return tx.auditLog.findMany({ where: { entityType: "Category", entityId: categoryId(id) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
      select: { id: true, action: true, actorId: true, createdAt: true, details: true } });
  });
}
export async function saveCategory(db: PrismaClient, actor: Actor, input: unknown) {
  try {
    return await db.$transaction(async tx => {
      await authorize(tx, actor);
      const request = categoryInput(input);
      const { key, ...intent } = request;
      const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: actor.id, ...intent })).digest("hex");
      // Serializes category management including normalized-name conflicts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 2)`;
      const receipt = await tx.auditLog.findUnique({ where: { id: key } });
      if (receipt) {
        const data = receipt.details as { fingerprint?: string; after?: CategoryRow } | null;
        if (receipt.entityType !== "Category" || receipt.actorId !== actor.id || data?.fingerprint !== fingerprint || !data.after) throw new CategoryError("IDEMPOTENCY_CONFLICT");
        return { category: data.after, replayed: true };
      }
      let before: CategoryRow | null = null;
      if (request.id) {
        await tx.$queryRaw`SELECT id FROM "Category" WHERE id = ${request.id}::uuid FOR UPDATE`;
        before = await tx.category.findUnique({ where: { id: request.id }, select });
        if (!before) throw new CategoryError("NOT_FOUND");
        if (before.revision !== request.expectedRevision) throw new CategoryError("STALE_REVISION");
      }
      const duplicates = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Category"
        WHERE lower(btrim(name)) = lower(btrim(${request.name})) AND (${request.id}::uuid IS NULL OR id <> ${request.id}::uuid)`;
      if (duplicates.length) throw new CategoryError("DUPLICATE_NAME");
      const fields = { name: request.name, displayOrder: request.displayOrder, active: request.active };
      const unchanged = before && before.name === fields.name && before.displayOrder === fields.displayOrder && before.active === fields.active;
      const category = unchanged && before ? before : before ? await tx.category.update({ where: { id: before.id }, data: { ...fields, revision: { increment: 1 } }, select }) :
        await tx.category.create({ data: fields, select });
      await tx.auditLog.create({ data: { id: key, actorId: actor.id, entityType: "Category", entityId: category.id,
        action: unchanged ? "CATEGORY_UNCHANGED" : before ? "CATEGORY_UPDATED" : "CATEGORY_CREATED",
        details: { fingerprint, before, after: category } } });
      return { category, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new CategoryError("DUPLICATE_NAME");
    throw error;
  }
}
