import "server-only";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { InventoryError, inventoryId } from "./domain";

export type RecipeActor = Pick<AuthenticatedUser, "id" | "role">;

/** Recheck and hold database authorization through the recipe transaction. */
export function withRecipeAccess<T>(db: PrismaClient, actor: RecipeActor, write: boolean,
  work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    const roles = write ? ["ADMIN", "STOCK_MANAGEMENT"] : ["ADMIN", "STOCK_MANAGEMENT", "FINANCE"];
    if (!actor || !roles.includes(actor.role)) throw new InventoryError("FORBIDDEN");
    const id = inventoryId(actor.id);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
    const current = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!current?.active || !roles.includes(current.role)) throw new InventoryError("FORBIDDEN");
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
