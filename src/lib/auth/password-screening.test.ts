import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPasswordBlocklist, screenNewPassword, generateTemporaryPassword } from "./password-screening";
import { hashPassword, verifyPassword } from "./password";

test("pinned offline corpus fails closed on corruption", () => {
  const bytes = readFileSync(new URL("password-blocklist.txt", import.meta.url));
  const rows = bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(rows.length, 150000);
  assert.equal(new Set(rows).size, rows.length);
  assert.equal(new Set(rows.map(value => value.normalize("NFC").toLowerCase())).size, rows.length);
  assert.equal(loadPasswordBlocklist(bytes).size, 150007);
  assert.ok(loadPasswordBlocklist(bytes).size >= 100000);
  for (const value of rows) assert.equal(value.normalize("NFC").toLowerCase().normalize("NFC").toLowerCase(), value.normalize("NFC").toLowerCase());
  assert.deepEqual(loadPasswordBlocklist(Buffer.from(bytes.toString("utf8").replace(/\r?\n/g, "\r\n"))), loadPasswordBlocklist(bytes));
  assert.throws(() => loadPasswordBlocklist(Buffer.from("truncated")), { code: "SCREENING_UNAVAILABLE" });
});
test("missing and corrupt corpus prevent issuance but leave legacy password verification available", () => {
  const directory = mkdtempSync(join(tmpdir(), "aroom-corpus-test-"));
  try {
    // Run a fresh process so successful in-process corpus caching cannot hide the
    // missing-file branch. Only a generated temporary directory is modified.
    const code = `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      const { hashPassword, verifyPassword } = require('./src/lib/auth/password.ts');
      const { generateTemporaryPassword } = require('./src/lib/auth/password-screening.ts');
      const { authenticateCredentials } = require('./src/lib/auth/credentials.ts');
      const { prisma } = require('./src/lib/db');
      (async () => {
        process.chdir(process.env.AROOM_CORPUS_TEST_DIRECTORY);
        const legacy = 'old-short', stored = await require('@node-rs/argon2').hash(legacy);
        prisma.$queryRaw = async () => [{attempts:1}];
        prisma.user.findUnique = async () => ({id:'fixture', name:'Fixture', loginIdentifier:'fixture', role:'CASHIER', active:true, credentialsVersion:1, mustChangePassword:false, passwordHash:stored});
        for (const corrupt of [false, true]) {
          if (corrupt) { fs.mkdirSync('src/lib/auth', {recursive:true}); fs.writeFileSync('src/lib/auth/password-blocklist.txt', 'corrupt'); }
          await assert.rejects(hashPassword('a strong distinct fixture phrase'), {code:'SCREENING_UNAVAILABLE'});
          assert.throws(() => generateTemporaryPassword(), {code:'SCREENING_UNAVAILABLE'});
          assert.equal(await verifyPassword(stored, legacy), true);
          assert.equal((await authenticateCredentials('fixture', legacy)).id, 'fixture');
        }
      })().catch(() => { process.exitCode = 1; });`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "-e", code], {
      env: { ...process.env, AROOM_CORPUS_TEST_DIRECTORY: directory }, encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    const safePath = resolve(directory);
    assert.ok(safePath.startsWith(resolve(tmpdir()) + "\\aroom-corpus-test-") || safePath.startsWith(resolve(tmpdir()) + "/aroom-corpus-test-"));
    rmSync(safePath, { recursive: true });
  }
});
test("common whole passwords reject without disclosing values; Unicode passphrases keep exact bytes", async () => {
  for (const value of ["password1234", "AROOMCOFFEE123", "123456789012", "adminadminadmin"]) {
    await assert.rejects(hashPassword(value), error => error instanceof Error && error.message === "COMMON_PASSWORD" && !error.message.includes(value));
  }
  const password = "  kopi é senja 🌙 panjang  ";
  screenNewPassword(password);
  const hash = await hashPassword(password);
  assert.ok(await verifyPassword(hash, password));
  assert.equal(await verifyPassword(hash, password.trim()), false);
  assert.equal(await verifyPassword(hash, password.normalize("NFD")), false);
});
test("temporary credentials remain independently random, screened and 192 bits", () => {
  const values = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
  assert.equal(values.size, 50);
  for (const value of values) { assert.match(value, /^[A-Za-z0-9_-]{32}$/); screenNewPassword(value); }
});
