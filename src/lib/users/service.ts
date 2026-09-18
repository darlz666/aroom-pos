import "server-only";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { hashPassword } from "../auth/password";
import { changeRoleInput, createUserInput, setActiveInput, UserManagementError, type ManagedUser, type UserActor } from "./domain";

const select = { id: true, name: true, loginIdentifier: true, role: true, active: true } as const;
// Explicit projection also protects callers when a test adapter returns extra fields.
function dto(user: ManagedUser): ManagedUser {
  return { id: user.id, name: user.name, loginIdentifier: user.loginIdentifier, role: user.role, active: user.active };
}
async function assertAdmin(db: Pick<Prisma.TransactionClient, "user">, actor: UserActor) {
  if (!actor || actor.role !== "ADMIN" || typeof actor.id !== "string" || !/^[0-9a-f-]{36}$/i.test(actor.id)) throw new UserManagementError("FORBIDDEN");
  const current = await db.user.findUnique({ where: { id: actor.id }, select: { role: true, active: true } });
  if (!current?.active || current.role !== "ADMIN") throw new UserManagementError("FORBIDDEN");
}

/** Actor always comes from the authenticated server session, never request data. */
export async function listUsers(db: PrismaClient, actor: UserActor) {
  await assertAdmin(db, actor);
  return (await db.user.findMany({ select, orderBy: [{ name: "asc" }, { id: "asc" }] })).map(dto);
}

function mutate<T>(db: PrismaClient, actor: UserActor, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    // Serialize all access mutations before reading actor/target/admin count.
    // A waiting request rechecks a demoted/deactivated actor after the winner commits.
    // This transaction-scoped PostgreSQL lock requires no extra table or infrastructure.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 1)`;
    await assertAdmin(tx, actor);
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function createUser(db: PrismaClient, actor: UserActor, input: unknown) {
  await assertAdmin(db, actor);
  const { password, ...fields } = createUserInput(input);
  const passwordHash = await hashPassword(password);
  try {
    return await mutate(db, actor, async tx => {
      const user = await tx.user.create({ data: { ...fields, passwordHash, active: true }, select });
      await tx.auditLog.create({ data: { actorId: actor.id, action: "USER_CREATED", entityType: "User", entityId: user.id,
        details: { role: user.role, active: user.active } } });
      return dto(user);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new UserManagementError("DUPLICATE_LOGIN");
    throw error;
  }
}

async function updateAccess(db: PrismaClient, actor: UserActor, targetId: string, change: { role?: ManagedUser["role"]; active?: boolean }) {
  return mutate(db, actor, async tx => {
    const before = await tx.user.findUnique({ where: { id: targetId }, select });
    if (!before) throw new UserManagementError("NOT_FOUND");
    const role = change.role ?? before.role;
    const active = change.active ?? before.active;
    if (before.active && before.role === "ADMIN" && (!active || role !== "ADMIN") &&
        await tx.user.count({ where: { role: "ADMIN", active: true } }) <= 1) throw new UserManagementError("LAST_ADMIN");
    if (targetId === actor.id && (!active || role !== "ADMIN")) throw new UserManagementError("SELF_ACCESS_CHANGE");
    if (role === before.role && active === before.active) return dto(before);
    const user = await tx.user.update({ where: { id: targetId }, data: change, select });
    await tx.auditLog.create({ data: { actorId: actor.id, action: change.role === undefined ? "USER_ACTIVE_CHANGED" : "USER_ROLE_CHANGED",
      entityType: "User", entityId: targetId,
      details: { before: { role: before.role, active: before.active }, after: { role: user.role, active: user.active } } } });
    return dto(user);
  });
}
export async function changeUserRole(db: PrismaClient, actor: UserActor, input: unknown) {
  await assertAdmin(db, actor);
  const value = changeRoleInput(input);
  return updateAccess(db, actor, value.userId, { role: value.role });
}
export async function setUserActive(db: PrismaClient, actor: UserActor, input: unknown) {
  await assertAdmin(db, actor);
  const value = setActiveInput(input);
  return updateAccess(db, actor, value.userId, { active: value.active });
}
