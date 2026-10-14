import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { PrismaClient } from "../../generated/prisma/client";
import { admitAuthentication, throttleKey } from "./throttle";

test("throttle fails closed without key configuration and sanitizes storage failures", async () => {
  const before = process.env.AUTH_THROTTLE_HMAC_SECRET;
  try {
    delete process.env.AUTH_THROTTLE_HMAC_SECRET;
    assert.throws(() => throttleKey("LOGIN", "person"), /Authentication unavailable/);
    process.env.AUTH_THROTTLE_HMAC_SECRET = randomBytes(32).toString("base64");
    assert.notEqual(throttleKey("LOGIN", "person"), throttleKey("REAUTH", "person"));
    const db = { $queryRaw: async () => { throw new Error("private database credential"); } } as unknown as PrismaClient;
    await assert.rejects(admitAuthentication(db, "LOGIN", "person"), error => error instanceof Error && error.message === "Authentication unavailable");
  } finally { if (before === undefined) delete process.env.AUTH_THROTTLE_HMAC_SECRET; else process.env.AUTH_THROTTLE_HMAC_SECRET = before; }
});
test("dedicated key rejects malformed, short, patterned and reused session secrets without disclosure", () => {
  const before = process.env.AUTH_THROTTLE_HMAC_SECRET, session = process.env.SESSION_SECRET;
  try {
    process.env.SESSION_SECRET = randomBytes(32).toString("base64");
    for (const value of [undefined, "", "not base64!", " ".repeat(44), randomBytes(31).toString("base64"),
      randomBytes(65).toString("base64"), Buffer.alloc(32, 1).toString("base64"),
      Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
      Buffer.concat(Array(2).fill(Buffer.from(Array.from({ length: 16 }, (_, i) => i)))).toString("base64"),
      process.env.SESSION_SECRET, Buffer.from(process.env.SESSION_SECRET).toString("base64"),
      randomBytes(32).toString("base64").replace(/=$/, ""), randomBytes(32).toString("base64") + "\n"]) {
      if (value === undefined) delete process.env.AUTH_THROTTLE_HMAC_SECRET; else process.env.AUTH_THROTTLE_HMAC_SECRET = value;
      assert.throws(() => throttleKey("LOGIN", "person"), error => error instanceof Error && error.message === "Authentication unavailable");
    }
    for (const length of [32, 48, 64]) {
      process.env.AUTH_THROTTLE_HMAC_SECRET = randomBytes(length).toString("base64");
      assert.match(throttleKey("LOGIN", "person"), /^[a-f0-9]{64}$/);
    }
    const key = throttleKey("LOGIN", "person");
    process.env.SESSION_SECRET = randomBytes(32).toString("base64");
    assert.equal(throttleKey("LOGIN", "person"), key);
    process.env.AUTH_THROTTLE_HMAC_SECRET = randomBytes(32).toString("base64");
    assert.notEqual(throttleKey("LOGIN", "person"), key);
  } finally {
    if (before === undefined) delete process.env.AUTH_THROTTLE_HMAC_SECRET; else process.env.AUTH_THROTTLE_HMAC_SECRET = before;
    if (session === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = session;
  }
});
test("independent processes derive stable keys with the same dedicated secret", () => {
  const env = { ...process.env, AUTH_THROTTLE_HMAC_SECRET: randomBytes(32).toString("base64") };
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "-e",
    "process.stdout.write(require('./src/lib/auth/throttle.ts').throttleKey('LOGIN', 'synthetic-fixture'))"], { env, encoding: "utf8", windowsHide: true });
  const first = run(), second = run();
  assert.equal(first.status, 0); assert.equal(second.status, 0);
  assert.match(first.stdout, /^[a-f0-9]{64}$/); assert.equal(first.stdout, second.stdout);
});
test("unverified client IP headers are not consumed by authentication", () => {
  for (const file of ["throttle.ts", "credentials.ts", "actions.ts", "recovery-actions.ts", "recovery-service.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["']next\/headers|x-forwarded-for|cf-connecting-ip|x-real-ip/i);
  }
});
