import "server-only";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { hashPassword, verifyPassword } from "../auth/password";
import { BootstrapError, bootstrapInput, type bootstrapTarget } from "./domain";

export type MigrationEvidence = { name: string; checksum: string };
export async function bootstrapAdmin(db: PrismaClient, target: ReturnType<typeof bootstrapTarget>,
  migrations: MigrationEvidence[], input: ReturnType<typeof bootstrapInput>) {
  if (!/^(aroom_pos_operational_[a-z0-9_]+|aroom_bootstrap_test_[a-f0-9]{32})$/.test(target.database)) throw new BootstrapError("INVALID_TARGET");
  const validated = bootstrapInput(input.name, input.loginIdentifier, input.password, input.password);
  if (!migrations.length || new Set(migrations.map(m => m.name)).size !== migrations.length) throw new BootstrapError("MIGRATIONS_REQUIRED");
  const passwordHash = await hashPassword(validated.password);
  if (!await verifyPassword(passwordHash, validated.password)) throw new BootstrapError("INVALID_INPUT");
  return db.$transaction(async tx => {
    const [identity] = await tx.$queryRaw<{ database: string; user: string; schema: string; port: number }[]>`
      SELECT current_database() AS database, current_user AS user, current_schema() AS schema, inet_server_port() AS port`;
    if (identity.database !== target.database || identity.user !== target.user || identity.schema !== "public" || identity.port !== target.port) {
      throw new BootstrapError("IDENTITY_MISMATCH");
    }
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(183621, 1)`;
    const applied = await tx.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name`;
    const expected = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
    if (applied.length !== expected.length || applied.some((row, i) => !row.finished_at || row.rolled_back_at ||
      row.migration_name !== expected[i].name || row.checksum !== expected[i].checksum)) throw new BootstrapError("MIGRATIONS_REQUIRED");
    // All current models use their model name as the physical table name.
    const tables = Object.values(Prisma.ModelName).sort();
    const actualTables = await tx.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    if (JSON.stringify(actualTables.map(row => row.tablename).sort()) !== JSON.stringify([...tables, "_prisma_migrations"].sort())) {
      throw new BootstrapError("DATABASE_NOT_EMPTY");
    }
    // Lock every application table before checking emptiness; bootstrap is an offline operation.
    // Identifiers come solely from the generated application schema, never CLI input.
    const quote = (name: string) => `public."${name.replaceAll('"', '""')}"`;
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map(quote).join(", ")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of tables) {
      const [row] = await tx.$queryRawUnsafe<{ present: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM ${quote(table)} LIMIT 1) AS present`);
      if (row.present) throw new BootstrapError("DATABASE_NOT_EMPTY");
    }
    const user = await tx.user.create({ data: { name: validated.name, loginIdentifier: validated.loginIdentifier, passwordHash, role: "ADMIN", active: true },
      select: { id: true } });
    await tx.auditLog.create({ data: { actorId: user.id, action: "FIRST_ADMIN_BOOTSTRAPPED", entityType: "User", entityId: user.id,
      details: { role: "ADMIN", active: true } } });
    return user;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 });
}
