import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync, readdirSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { readPrompt } from "../src/lib/bootstrap/prompt";
import { assertRecoveryInvocation, EmergencyRecoveryError, recoveryIntent, recoveryTarget, verifiedHostEvidence } from "../src/lib/auth/emergency-recovery/domain";
import { inspectRecovery, recoverAdmin } from "../src/lib/auth/emergency-recovery/service";
import { PasswordScreeningError } from "../src/lib/auth/password-screening";

async function main() {
  // No arguments, environment passwords, dotenv, defaults, or redirected input/output.
  assertRecoveryInvocation(process.argv, process.stdin.isTTY, process.stdout.isTTY, process.env);
  const target = recoveryTarget(process.env);
  const addresses = await lookup(target.host.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.some(row => row.address === target.serverAddress)) throw new EmergencyRecoveryError("IDENTITY_MISMATCH");
  const evidence = verifiedHostEvidence(process.env);
  const prompt = (label: string, hidden = false) => readPrompt(process.stdin, process.stdout, label, hidden);
  process.stdout.write(`Emergency maintenance target: ${target.host}:${target.port}/${target.database}, schema ${target.schema}.\nExternal owner approval, restricted host access, verified backup and stopped/drained service are required.\nTyped names/references do not prove authorization.\n`);
  if (await prompt("Type the exact database name to confirm: ") !== target.database) throw new EmergencyRecoveryError("INVALID_TARGET");
  const intent = recoveryIntent({ operationId: await prompt("Owner-approved operation UUID: "), targetUserId: await prompt("Existing active ADMIN UUID: "),
    expectedVersion: Number(await prompt("Expected credentialsVersion: ")), approvalReference: await prompt("Owner approval reference (no secrets): "),
    operatorIdentity: await prompt("External operator identity (metadata, no secrets): ") });
  const directory = new URL("./migrations/", import.meta.url);
  const migrations = readdirSync(directory, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ name: e.name,
    checksum: createHash("sha256").update(readFileSync(new URL(`${e.name}/migration.sql`, directory))).digest("hex") }));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.connectionString }) });
  let password = "", confirmation = "";
  try {
    const status = await inspectRecovery(db, target, migrations, intent, evidence);
    process.stdout.write(`Operation ${intent.operationId}: ${status.operation}; current credential version ${status.currentVersion}.\n`);
    if (status.operation !== "NOT_FOUND") return;
    const action = await prompt("Type STATUS to exit, or RECOVER to perform this approved operation: ");
    if (action === "STATUS") return;
    if (action !== "RECOVER") throw new EmergencyRecoveryError("INVALID_INPUT");
    password = await prompt("New password (20-128 Unicode code points, hidden): ", true);
    confirmation = await prompt("Confirm new password (hidden): ", true);
    const result = await recoverAdmin(db, target, migrations, intent, evidence, password, confirmation);
    process.stdout.write(`Operation ${intent.operationId}: ${result.operation}; credential version ${result.currentVersion}. Fresh HTTPS login is required.\n`);
  } finally { password = ""; confirmation = ""; await db.$disconnect(); }
}
void main().catch(error => {
  // Never print provider/terminal exceptions, URLs, input, hashes or tokens.
  const code = error instanceof EmergencyRecoveryError || error instanceof PasswordScreeningError ? error.code : "UNAVAILABLE";
  console.error(`Emergency recovery stopped: ${code}. Inspect the same operation's status before further action; a new recovery requires separate approval and a new UUID.`);
  process.exitCode = 1;
});
