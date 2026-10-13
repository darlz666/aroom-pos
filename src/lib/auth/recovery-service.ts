import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { hashPassword, verifyPassword } from "./password";
import { changePasswordInput, currentPassword, recoveryId, resetInput, RecoveryError } from "./recovery-domain";
import type { SessionIdentity } from "./session-token";

type Actor = SessionIdentity;
async function authenticated(tx: Prisma.TransactionClient, actor: Actor) {
  const user = await tx.user.findUnique({ where: { id: recoveryId(actor.userId) } });
  if (!user?.active || user.credentialsVersion !== actor.credentialsVersion) throw new RecoveryError("FORBIDDEN");
  if (user.mustChangePassword && (!user.temporaryCredentialExpiresAt || user.temporaryCredentialExpiresAt.getTime() <= Date.now())) throw new RecoveryError("EXPIRED");
  return user;
}
async function admin(tx: Prisma.TransactionClient, actor: Actor) {
  const user = await authenticated(tx, actor);
  if (user.role !== "ADMIN" || user.mustChangePassword) throw new RecoveryError("FORBIDDEN");
  return user;
}
function transaction<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    // Same lock as all access mutations and first ADMIN bootstrap.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 1)`;
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
}
async function status(tx: Prisma.TransactionClient, actor: Actor, userId: string, operationId?: string) {
  const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, role: true, active: true, credentialsVersion: true, mustChangePassword: true, temporaryCredentialExpiresAt: true } });
  if (!target || target.role === "ADMIN" || target.id === actor.userId || !target.active) throw new RecoveryError("FORBIDDEN");
  const receipt = operationId ? await tx.auditLog.findUnique({ where: { id: operationId } }) : null;
  if (receipt && (receipt.entityType !== "CredentialRecovery" || receipt.action !== "USER_PASSWORD_RESET" || receipt.actorId !== actor.userId || receipt.entityId !== userId)) throw new RecoveryError("INTENT_CONFLICT");
  const details = receipt?.details as { resultingVersion?: number } | null;
  return { userId, credentialsVersion: target.credentialsVersion, expiresAt: target.temporaryCredentialExpiresAt?.toISOString() ?? null,
    state: !target.mustChangePassword ? "NORMAL" as const : target.temporaryCredentialExpiresAt!.getTime() <= Date.now() ? "EXPIRED" as const : "TEMPORARY" as const,
    operation: !receipt ? "NOT_FOUND" as const : details?.resultingVersion === target.credentialsVersion ? "APPLIED" as const : "SUPERSEDED" as const };
}
export function readResetStatus(db: PrismaClient, actor: Actor, userId: unknown, operationId?: unknown) {
  return transaction(db, async tx => {
    await admin(tx, actor);
    return status(tx, actor, recoveryId(userId), operationId === undefined ? undefined : recoveryId(operationId));
  });
}
export function resetUserPassword(db: PrismaClient, actor: Actor, input: unknown) {
  const request = resetInput(input);
  return transaction(db, async tx => {
    const operator = await admin(tx, actor);
    if (!await verifyPassword(operator.passwordHash, request.adminPassword)) throw new RecoveryError("REAUTHENTICATE");
    const current = await status(tx, actor, request.userId, request.operationId);
    const receipt = await tx.auditLog.findUnique({ where: { id: request.operationId } });
    if (receipt) {
      const details = receipt.details as { expectedVersion?: number } | null;
      if (details?.expectedVersion !== request.expectedVersion) throw new RecoveryError("INTENT_CONFLICT");
      return { status: current, replayed: true, temporaryPassword: null };
    }
    if (current.credentialsVersion !== request.expectedVersion) throw new RecoveryError("STALE_VERSION");
    const temporaryPassword = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await tx.user.update({ where: { id: request.userId }, data: { passwordHash, credentialsVersion: { increment: 1 }, mustChangePassword: true, temporaryCredentialExpiresAt: expiresAt } });
    await tx.auditLog.create({ data: { id: request.operationId, actorId: operator.id, action: "USER_PASSWORD_RESET", entityType: "CredentialRecovery", entityId: request.userId,
      details: { expectedVersion: request.expectedVersion, resultingVersion: request.expectedVersion + 1, expiresAt: expiresAt.toISOString() } } });
    return { status: await status(tx, actor, request.userId, request.operationId), replayed: false, temporaryPassword };
  });
}
export function changePassword(db: PrismaClient, actor: Actor, input: unknown) {
  const request = changePasswordInput(input);
  return transaction(db, async tx => {
    const user = await authenticated(tx, actor);
    if (!user.mustChangePassword && !await verifyPassword(user.passwordHash, currentPassword(request.currentPassword))) throw new RecoveryError("REAUTHENTICATE");
    if (await verifyPassword(user.passwordHash, request.newPassword)) throw new RecoveryError("INVALID_INPUT");
    const passwordHash = await hashPassword(request.newPassword);
    if (user.mustChangePassword && user.temporaryCredentialExpiresAt!.getTime() <= Date.now()) throw new RecoveryError("EXPIRED");
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, credentialsVersion: { increment: 1 }, mustChangePassword: false, temporaryCredentialExpiresAt: null } });
    await tx.auditLog.create({ data: { actorId: user.id, action: "USER_PASSWORD_CHANGED", entityType: "CredentialRecovery", entityId: user.id,
      details: { previousVersion: user.credentialsVersion, resultingVersion: user.credentialsVersion + 1, mandatory: user.mustChangePassword } } });
    return { changed: true };
  });
}
