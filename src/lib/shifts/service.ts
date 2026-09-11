import "server-only";

import { Prisma, type PrismaClient, type Shift } from "../../generated/prisma/client";
import { assertCanOperateShift, type ShiftActor } from "./domain";

/** Read-only snapshot. Never use this read alone to authorize a later write. */
export function findActiveShift(db: Pick<Prisma.TransactionClient, "shift">): Promise<Shift | null> {
  return db.shift.findFirst({ where: { status: "OPEN" } });
}

/** Lock by ID, not status, so a waiter observes a concurrently closed shift. */
export async function lockShift(tx: Prisma.TransactionClient, shiftId: string): Promise<Shift | null> {
  const rows = await tx.$queryRaw<Shift[]>`
    SELECT * FROM "Shift" WHERE "id" = ${shiftId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Trusted server caller supplies a freshly authenticated actor and validated shift ID. */
export function withOperableShift<T>(
  db: PrismaClient,
  actor: ShiftActor,
  shiftId: string,
  work: (tx: Prisma.TransactionClient, shift: Shift) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    assertCanOperateShift(actor, shift);
    return work(tx, shift!);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
