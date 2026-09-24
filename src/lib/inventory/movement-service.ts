import "server-only";
import type { PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";

export async function listStockMovements(
  db: PrismaClient,
  actor: AuthenticatedUser,
  limit = 100
) {
  void actor;

  return db.stockMovement.findMany({
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    include: {
      ingredient: {
        select: {
          name: true,
          baseUnit: true,
        },
      },
      actor: {
        select: {
          name: true,
        },
      },
    },
  });
}