import "server-only";

import { Prisma, type PrismaClient, type Shift } from "../../generated/prisma/client";
import { assertCanOpenShift, assertCanOperateShift, parseShiftMoney, ShiftError, type ShiftActor } from "./domain";

export type OpenShiftResult = { state: "CREATED" | "EXISTING"; shift: Shift };

function resumeShift(actor: ShiftActor, shift: Shift): OpenShiftResult {
  if (shift.cashierId !== actor.id) throw new ShiftError("REGISTER_OCCUPIED");
  return { state: "EXISTING", shift };
}

/** Actor must come from requireUser(), never client input. */
export async function openShift(db: PrismaClient, actor: ShiftActor, input: unknown): Promise<OpenShiftResult> {
  assertCanOpenShift(actor, null);
  const openingCash = parseShiftMoney(input);
  let createConflict = false;
  try {
    return await db.$transaction(async (tx) => {
      const active = await findActiveShift(tx);
      if (active) return resumeShift(actor, active);
      assertCanOpenShift(actor, active);
      let shift: Shift;
      try {
        // openedAt uses the database default; closing fields remain null.
        shift = await tx.shift.create({ data: { cashierId: actor.id, status: "OPEN", openingCash } });
      } catch (error) {
        createConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
        throw error;
      }
      await tx.auditLog.create({ data: {
        actorId: actor.id, action: "SHIFT_OPENED", entityType: "Shift", entityId: shift.id,
        details: { shiftOwnerId: actor.id, openingCash, openedAt: shift.openedAt.toISOString() },
      } });
      return { state: "CREATED", shift };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (createConflict) {
      // The failed transaction has rolled back. Never query or retry inside it.
      const active = await findActiveShift(db);
      if (active) return resumeShift(actor, active);
    }
    throw error;
  }
}

export async function getActiveRegisterState(db: Pick<Prisma.TransactionClient, "shift">, actor: ShiftActor) {
  assertCanOpenShift(actor, null);
  const shift = await db.shift.findFirst({
    where: { status: "OPEN" },
    select: { id: true, cashierId: true, status: true, openedAt: true, openingCash: true, cashier: { select: { name: true } } },
  });
  if (!shift) return { state: "EMPTY", shift: null } as const;
  const ownsShift = shift.cashierId === actor.id;
  const mayOperate = ownsShift || actor.role === "ADMIN";
  const summary = {
    id: shift.id, ownerName: shift.cashier.name, openedAt: shift.openedAt.toISOString(),
    status: shift.status, ownsShift, mayOperate,
  };
  if (actor.role === "ADMIN") return { state: "ADMIN_VIEW", shift: { ...summary, openingCash: shift.openingCash } } as const;
  if (ownsShift) return { state: "OWNED", shift: { ...summary, openingCash: shift.openingCash } } as const;
  return { state: "OCCUPIED", shift: summary } as const;
}

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
