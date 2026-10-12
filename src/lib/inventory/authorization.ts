import "server-only";
import type { Prisma } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { InventoryError, inventoryId } from "./domain";

export type InventoryActor = Pick<AuthenticatedUser, "id" | "role">;

/** Internal only. Hold fresh inventory authorization until the caller commits. */
export async function authorizeInventory(tx: Prisma.TransactionClient, actor: InventoryActor) {
  if (!actor || !["ADMIN", "STOCK_MANAGEMENT"].includes(actor.role)) throw new InventoryError("FORBIDDEN");
  const id = inventoryId(actor.id);
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR SHARE`;
  const current = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
  if (!current?.active || !["ADMIN", "STOCK_MANAGEMENT"].includes(current.role)) throw new InventoryError("FORBIDDEN");
}
