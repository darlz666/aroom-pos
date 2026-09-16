"use server";

import { requireUser } from "../auth/authorization";
import { prisma } from "../db";
import { getShiftSettlement } from "./settlement";

export async function getShiftSettlementAction(shiftId: string) {
  const actor = await requireUser();
  try {
    if (typeof shiftId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) throw new Error("Invalid shift");
    if (actor.role !== "ADMIN" && actor.role !== "CASHIER") throw new Error("Forbidden");
    const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: { cashierId: true } });
    if (!shift || (actor.role !== "ADMIN" && shift.cashierId !== actor.id)) throw new Error("Forbidden");
    const settlement = await getShiftSettlement(prisma, shiftId);
    return { success: true, settlement: { ...settlement,
      openedAt: settlement.openedAt.toISOString(), closedAt: settlement.closedAt?.toISOString() ?? null,
    } } as const;
  } catch {
    return { success: false, error: "Settlement belum dapat dimuat. Periksa koneksi dan akses shift, lalu coba lagi." } as const;
  }
}
