import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { bootstrapInput, bootstrapTarget, BootstrapError } from "../src/lib/bootstrap/domain";
import { bootstrapAdmin } from "../src/lib/bootstrap/service";
import { readPrompt } from "../src/lib/bootstrap/prompt";

async function prompt(label: string, hidden = false): Promise<string> {
  return readPrompt(process.stdin, process.stdout, label, hidden);
}
async function main() {
  // No arguments, redirected passwords, dotenv, demo seed, or default target.
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new BootstrapError("INVALID_INPUT");
  const target = bootstrapTarget(process.env);
  const directory = new URL("./migrations/", import.meta.url);
  const migrations = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => ({
    name: entry.name, checksum: createHash("sha256").update(readFileSync(new URL(`${entry.name}/migration.sql`, directory))).digest("hex"),
  }));
  process.stdout.write(`Target: ${target.host}:${target.port}/${target.database}\nKeep the application stopped. Store the password in the owner's password manager.\n`);
  if (await prompt("Type the exact database name to confirm: ") !== target.database) throw new BootstrapError("INVALID_TARGET");
  const input = bootstrapInput(await prompt("Admin name: "), await prompt("Login identifier: "),
    await prompt("Strong password (20-128 characters, hidden): ", true), await prompt("Confirm password (hidden): ", true));
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.connectionString }) });
  try {
    const user = await bootstrapAdmin(db, target, migrations, input);
    process.stdout.write(`First ADMIN created: ${user.id}. Verify HTTPS login and logout before opening staff access.\n`);
  } finally { input.password = ""; await db.$disconnect(); }
}
void main().catch(error => {
  // Provider/terminal errors may contain secrets. Never log error objects or input.
  console.error(`Bootstrap stopped: ${error instanceof BootstrapError ? error.code : "UNAVAILABLE"}. No retry can replace an existing account; inspect safe database state first.`);
  process.exitCode = 1;
});
