import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client";
import type { AuthenticatedUser } from "../auth/credentials";
import { jakartaBusinessDate } from "../reports/domain";
import { periodRange, sumMoney } from "../finance/domain";
import { integer, mutationInput, object, ProcurementError, statuses, total, transition, uuid } from "./domain";

type Actor = Pick<AuthenticatedUser, "id" | "role">;
async function authorize(tx: Prisma.TransactionClient, actor: Actor) {
  if (!actor?.id) throw new ProcurementError("Akses ditolak.");
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id}::uuid FOR SHARE`;
  const user = await tx.user.findFirst({ where: { id: actor.id, active: true, role: { in: ["PROCUREMENT", "FINANCE", "ADMIN"] } }, select: { id: true, role: true } });
  if (!user) throw new ProcurementError("Akses ditolak.");
  return user;
}

export async function saveProcurement(db: PrismaClient, actor: Actor, input: unknown) {
  const request = mutationInput(input);
  return db.$transaction(async tx => {
    const user = await authorize(tx, actor);
    const approval = request.operation === "APPROVE" || request.operation === "REJECT";
    if (user.role !== (approval ? "FINANCE" : "PROCUREMENT")) throw new ProcurementError("Akses ditolak.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: user.id, ...request })).digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.key}, 927))`;
    const replay = await tx.procurementEvent.findUnique({ where: { key: request.key } });
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new ProcurementError("Kunci permintaan telah digunakan untuk data berbeda.");
      return { id: replay.procurementId, revision: replay.revision };
    }
    // Also serialize concurrent CREATE requests using different keys for one id.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${request.id}, 928))`;
    await tx.$queryRaw`SELECT id FROM "Procurement" WHERE id = ${request.id}::uuid FOR UPDATE`;
    const before = await tx.procurement.findUnique({ where: { id: request.id } });
    if (request.operation === "CREATE" ? !!before : !before || before.revision !== request.revision) throw new ProcurementError("Data telah berubah. Muat ulang permintaan.");
    const status = transition(user.role, request.operation, before?.status ?? null, before?.createdBy === user.id);
    const now = new Date();
    const data: Prisma.ProcurementUpdateInput = { status, revision: { increment: 1 } };
    if (request.operation === "EDIT") Object.assign(data, request.data!);
    if (approval) Object.assign(data, { decisionActor: { connect: { id: user.id } }, decidedAt: now, decisionNote: request.note });
    if (request.operation === "ORDER") Object.assign(data, { orderedAt: now, actualUnitPrice: request.actualUnitPrice,
      actualTotal: request.actualUnitPrice === null ? null : total(before!.quantity, request.actualUnitPrice) });
    if (request.operation === "RECEIVE") data.receivedAt = now;
    if (request.operation === "CANCEL") Object.assign(data, { cancelledAt: now, cancellationReason: request.note });
    const saved = request.operation === "CREATE" ? await tx.procurement.create({ data: {
      ...request.data!, id: request.id, referenceNumber: `PR-${jakartaBusinessDate(now).replaceAll("-", "")}-${randomUUID()}`, createdBy: user.id,
    } }) : await tx.procurement.update({ where: { id: request.id }, data });
    const snapshot = JSON.parse(JSON.stringify(saved)) as Prisma.InputJsonValue;
    await tx.procurementEvent.create({ data: { key: request.key, fingerprint, procurementId: saved.id, operation: request.operation,
      fromStatus: before?.status ?? null, toStatus: saved.status, actorId: user.id, note: request.note, revision: saved.revision, snapshot } });
    await tx.auditLog.create({ data: { actorId: user.id, action: `PROCUREMENT_${request.operation}`, entityType: "Procurement", entityId: saved.id,
      details: JSON.parse(JSON.stringify({ before, after: saved })) } });
    return { id: saved.id, revision: saved.revision };
  });
}

const people = { creator: { select: { name: true } }, decisionActor: { select: { name: true } } } as const;
export async function readProcurement(db: PrismaClient, actor: Actor, input: unknown) {
  const r = object(input, ["page", "status", "id"]);
  const page = integer(r.page ?? 1, 1);
  if (page > 100000 || (r.status !== undefined && r.status !== "" && !statuses.includes(r.status as typeof statuses[number]))) throw new ProcurementError("Filter tidak valid.");
  const id = r.id === undefined ? undefined : uuid(r.id);
  return db.$transaction(async tx => {
    await authorize(tx, actor);
    const period = periodRange({ type: "MONTH", value: jakartaBusinessDate().slice(0, 7) });
    const where: Prisma.ProcurementWhereInput = r.status ? { status: r.status as typeof statuses[number] } : {};
    const rows = await tx.procurement.findMany({ where, include: people, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 51 });
    const detail = id ? await tx.procurement.findUnique({ where: { id }, include: { ...people, events: { orderBy: { revision: "asc" }, select: {
      key: true, operation: true, fromStatus: true, toStatus: true, actor: { select: { name: true } }, createdAt: true, note: true, revision: true,
    } } } }) : null;
    if (id && !detail) throw new ProcurementError("Permintaan tidak ditemukan.");
    const counts = await tx.procurement.groupBy({ by: ["status"], _count: true });
    const received = await tx.procurement.count({ where: { receivedAt: { gte: period.start, lt: period.end } } });
    const estimates = await tx.procurement.findMany({ where: { createdAt: { gte: period.start, lt: period.end }, status: { notIn: ["CANCELLED", "REJECTED"] } }, select: { estimatedTotal: true } });
    const actuals = await tx.procurement.findMany({ where: { orderedAt: { gte: period.start, lt: period.end } }, select: { actualTotal: true } });
    return { rows: rows.slice(0, 50), hasMore: rows.length > 50, detail, dashboard: {
      waiting: counts.find(c => c.status === "WAITING_APPROVAL")?._count ?? 0,
      approved: counts.find(c => c.status === "APPROVED")?._count ?? 0,
      ordered: counts.find(c => c.status === "ORDERED")?._count ?? 0, received,
      estimated: sumMoney(estimates.map(r => r.estimatedTotal)), actual: actuals.some(r => r.actualTotal === null) ? null : sumMoney(actuals.map(r => r.actualTotal!)), month: period.value,
    } };
  }, { isolationLevel: "RepeatableRead" });
}
