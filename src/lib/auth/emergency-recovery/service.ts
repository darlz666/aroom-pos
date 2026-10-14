import "server-only";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import type { MigrationEvidence } from "../../bootstrap/service";
import { hashPassword } from "../password";
import { EmergencyRecoveryError, recoveryEvidence, recoveryIntent, recoveryPurpose, recoveryTarget, validateRecoveryPassword } from "./domain";

type Target = ReturnType<typeof recoveryTarget>;
type Intent = ReturnType<typeof recoveryIntent>;
type Evidence = ReturnType<typeof recoveryEvidence>;
type Identity = { database: string; user: string; sessionUser: string; schema: string; port: number; address: string };

async function verifiedTransaction<T>(db: PrismaClient, target: Target, migrations: MigrationEvidence[], work: (tx: Prisma.TransactionClient, identity: Identity) => Promise<T>) {
  // Revalidate even internal callers; never accept a caller's arbitrary URL identity.
  recoveryTarget({ RECOVERY_DATABASE_URL: target.connectionString, RECOVERY_EXPECTED_HOST: target.host,
    RECOVERY_EXPECTED_PORT: String(target.port), RECOVERY_EXPECTED_DATABASE: target.database, RECOVERY_EXPECTED_USER: target.user,
    RECOVERY_EXPECTED_SCHEMA: target.schema, RECOVERY_EXPECTED_SERVER_ADDRESS: target.serverAddress });
  if (migrations.length !== 22 || new Set(migrations.map(m => m.name)).size !== 22 ||
      !migrations.some(m => m.name === "20261016000000_emergency_admin_recovery") ||
      !migrations.some(m => m.name === "20261017000000_dual_printing") ||
      migrations.some(m => !/^[a-f0-9]{64}$/.test(m.checksum))) throw new EmergencyRecoveryError("MIGRATIONS_REQUIRED");
  return db.$transaction(async tx => {
    // The pg adapter serializes Date parameters as UTC without an offset and
    // expects UTC results. Scope this setting to the maintenance transaction.
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 1)`;
    const [identity] = await tx.$queryRaw<Identity[]>`SELECT current_database() AS database, current_user AS "user",
      session_user AS "sessionUser", current_schema() AS schema, inet_server_port() AS port, host(inet_server_addr()) AS address`;
    if (!identity || identity.database !== target.database || identity.user !== target.user || identity.sessionUser !== target.user ||
        identity.schema !== target.schema || identity.port !== target.port || identity.address !== target.serverAddress) throw new EmergencyRecoveryError("IDENTITY_MISMATCH");
    const applied = await tx.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name`;
    const expected = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    if (applied.length !== expected.length || applied.some((row, i) => !row.finished_at || row.rolled_back_at ||
        row.migration_name !== expected[i].name || row.checksum !== expected[i].checksum)) throw new EmergencyRecoveryError("MIGRATIONS_REQUIRED");
    return work(tx, identity);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
}

async function inspect(tx: Prisma.TransactionClient, target: Target, identity: Identity, intent: Intent, evidence: Evidence) {
  const receipt = await tx.emergencyAdminRecovery.findUnique({ where: { id: intent.operationId } });
  if (receipt && (receipt.targetUserId !== intent.targetUserId || receipt.expectedVersion !== intent.expectedVersion ||
      receipt.approvalReference !== intent.approvalReference || receipt.operatorIdentity !== intent.operatorIdentity ||
      receipt.osUsername !== evidence.osUsername || receipt.osUid !== evidence.osUid || receipt.hostname !== evidence.hostname ||
      receipt.databaseHost !== target.host || receipt.databasePort !== identity.port || receipt.databaseName !== identity.database ||
      receipt.databaseSchema !== identity.schema || receipt.databaseUser !== identity.user || receipt.databaseSessionUser !== identity.sessionUser ||
      receipt.databaseServerAddress !== identity.address || receipt.intent !== recoveryPurpose)) throw new EmergencyRecoveryError("INTENT_CONFLICT");
  // Row lock also prevents direct concurrent role/status changes while we write.
  await tx.$queryRaw`SELECT id FROM public."User" WHERE id = ${intent.targetUserId}::uuid FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: intent.targetUserId }, select: { role: true, active: true, credentialsVersion: true } });
  if (!user || (!receipt && (user.role !== "ADMIN" || !user.active))) throw new EmergencyRecoveryError("FORBIDDEN");
  return { operation: !receipt ? "NOT_FOUND" as const : user.credentialsVersion === receipt.resultingVersion ? "APPLIED" as const : "SUPERSEDED" as const,
    targetUserId: intent.targetUserId, currentVersion: user.credentialsVersion, resultingVersion: receipt?.resultingVersion ?? null };
}

// Maintenance-only module. Never imported by an HTTP route or server action.
export function inspectRecovery(db: PrismaClient, target: Target, migrations: MigrationEvidence[], input: Intent, hostEvidence: Evidence) {
  const intent = recoveryIntent(input), evidence = recoveryEvidence(hostEvidence);
  return verifiedTransaction(db, target, migrations, (tx, identity) => inspect(tx, target, identity, intent, evidence));
}
export function recoverAdmin(db: PrismaClient, target: Target, migrations: MigrationEvidence[], input: Intent, hostEvidence: Evidence, password?: string, confirmation?: string) {
  const intent = recoveryIntent(input), evidence = recoveryEvidence(hostEvidence);
  return verifiedTransaction(db, target, migrations, async (tx, identity) => {
    const status = await inspect(tx, target, identity, intent, evidence);
    if (status.operation !== "NOT_FOUND") return status; // Replay never consumes or validates a new credential.
    if (status.currentVersion !== intent.expectedVersion) throw new EmergencyRecoveryError("STALE_VERSION");
    const passwordHash = await hashPassword(validateRecoveryPassword(password, confirmation));
    await tx.user.update({ where: { id: intent.targetUserId, credentialsVersion: intent.expectedVersion, role: "ADMIN", active: true },
      data: { passwordHash, credentialsVersion: { increment: 1 }, mustChangePassword: false, temporaryCredentialExpiresAt: null } });
    // Read PostgreSQL time explicitly: Prisma may materialize now() defaults on
    // the client. Receipt evidence must use the database clock, not the CLI host.
    const [{ recoveredAt }] = await tx.$queryRaw<{ recoveredAt: Date }[]>`SELECT clock_timestamp()::timestamptz(3) AS "recoveredAt"`;
    await tx.emergencyAdminRecovery.create({ data: { id: intent.operationId, targetUserId: intent.targetUserId,
      expectedVersion: intent.expectedVersion, resultingVersion: intent.expectedVersion + 1,
      approvalReference: intent.approvalReference, operatorIdentity: intent.operatorIdentity, ...evidence,
      databaseHost: target.host, databasePort: identity.port, databaseName: identity.database, databaseSchema: identity.schema,
      databaseUser: identity.user, databaseSessionUser: identity.sessionUser, databaseServerAddress: identity.address, intent: recoveryPurpose, createdAt: recoveredAt } });
    return { operation: "APPLIED" as const, targetUserId: intent.targetUserId, currentVersion: intent.expectedVersion + 1, resultingVersion: intent.expectedVersion + 1 };
  });
}
