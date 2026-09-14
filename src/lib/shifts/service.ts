import "server-only";

import { Prisma, type PrismaClient, type Shift } from "../../generated/prisma/client";
import { assertCanCloseShift, assertCanOpenShift, assertCanOperateShift, calculateCashVariance, calculateExpectedCash, parseShiftMoney, ShiftError, validateShiftMoney, type ShiftActor } from "./domain";

export type CloseShiftInput = {
  shiftId: string;
  countedCash: unknown;
  discrepancyNote?: unknown;
  adminCloseReason?: unknown;
};

function closeNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ShiftError("INVALID_INPUT");
  return value.trim() || null;
}

/** Internal server API: actor must be freshly authenticated, never supplied by a client. */
export async function closeShift(db: PrismaClient, actor: ShiftActor, input: CloseShiftInput) {
  if (!input || typeof input.shiftId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.shiftId)) {
    throw new ShiftError("INVALID_INPUT");
  }
  return withOperableShift(db, actor, input.shiftId, async (tx, shift) => {
    // Every future order/payment writer must take this same Shift lock first,
    // then verify OPEN before writing. Hold it until its transaction commits.
    const unpaid = await tx.order.findFirst({ where: { shiftId: shift.id, status: "UNPAID" }, select: { id: true } });
    const pending = await tx.payment.findFirst({ where: { order: { shiftId: shift.id }, status: "PENDING" }, select: { id: true } });
    if (unpaid || pending) throw new ShiftError("UNRESOLVED_TRANSACTIONS");

    const cash = await tx.payment.aggregate({
      where: { order: { shiftId: shift.id }, method: "CASH", status: "SUCCEEDED" },
      _sum: { amount: true },
    });
    const expectedCash = calculateExpectedCash(shift.openingCash, cash._sum.amount ?? 0);
    const countedCash = validateShiftMoney(input.countedCash);
    const variance = calculateCashVariance(countedCash, expectedCash);
    assertCanCloseShift(actor, shift, input.adminCloseReason);
    const discrepancyNote = closeNote(input.discrepancyNote);
    const adminCloseReason = closeNote(input.adminCloseReason);
    if (variance !== 0 && !discrepancyNote) throw new ShiftError("DISCREPANCY_NOTE_REQUIRED");

    const closed = await tx.shift.update({ where: { id: shift.id }, data: {
      status: "CLOSED", closedAt: new Date(), expectedCash, countedCash, variance, closingNote: discrepancyNote,
    } });
    await tx.auditLog.create({ data: {
      actorId: actor.id, action: "SHIFT_CLOSED", entityType: "Shift", entityId: shift.id,
      details: {
        shiftOwnerId: shift.cashierId, closingActorId: actor.id,
        expectedCash, countedCash, variance, adminClosedOtherOwner: shift.cashierId !== actor.id,
        discrepancyNote, adminCloseReason,
      },
    } });
    return {
      id: closed.id, status: closed.status, closedAt: closed.closedAt!.toISOString(),
      expectedCash, countedCash, cashVariance: variance, discrepancyNote, adminCloseReason,
    };
  });
}

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
  if (ownsShift) return { state: "OWNED", shift: { ...summary, openingCash: shift.openingCash } } as const;
  if (actor.role === "ADMIN") return { state: "ADMIN_VIEW", shift: { ...summary, openingCash: shift.openingCash } } as const;
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
