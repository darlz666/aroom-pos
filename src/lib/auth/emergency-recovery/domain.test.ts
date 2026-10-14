import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { readPrompt } from "../../bootstrap/prompt";
import { assertRecoveryInvocation, recoveryIntent, recoveryTarget, validateRecoveryPassword, verifiedHostEvidence } from "./domain";

const targetEnvironment = {
  RECOVERY_DATABASE_URL: "postgresql://operator:unused@localhost:5432/aroom_pos_operational_launch",
  RECOVERY_EXPECTED_HOST: "localhost",
  RECOVERY_EXPECTED_PORT: "5432",
  RECOVERY_EXPECTED_DATABASE: "aroom_pos_operational_launch",
  RECOVERY_EXPECTED_SCHEMA: "public",
  RECOVERY_EXPECTED_USER: "operator",
  RECOVERY_EXPECTED_SERVER_ADDRESS: "127.0.0.1",
};
const intent = () => ({ operationId: randomUUID(), targetUserId: randomUUID(), expectedVersion: 1,
  approvalReference: "Owner approval test 4B-2B-2", operatorIdentity: "Independently authorized test operator" });

test("recovery target requires an explicit database and every expected identity field", () => {
  const target = recoveryTarget(targetEnvironment);
  assert.equal(target.database, "aroom_pos_operational_launch");
  assert.equal(target.schema, "public");
  assert.equal(target.port, 5432);
  assert.equal(target.serverAddress, "127.0.0.1");
  assert.throws(() => recoveryTarget({ DATABASE_URL: targetEnvironment.RECOVERY_DATABASE_URL }), { code: "INVALID_TARGET" });
  for (const key of Object.keys(targetEnvironment)) {
    const missing = { ...targetEnvironment } as Record<string, string | undefined>;
    delete missing[key];
    assert.throws(() => recoveryTarget(missing), { code: "INVALID_TARGET" });
  }
  const disposable = `aroom_access_test_${randomUUID().replaceAll("-", "")}`;
  assert.equal(recoveryTarget({ ...targetEnvironment, RECOVERY_EXPECTED_DATABASE: disposable,
    RECOVERY_DATABASE_URL: `postgresql://operator:unused@localhost:5432/${disposable}?schema=public` }).database, disposable);
});

test("recovery rejects ambiguous URL options, mismatched identity and the operational legacy database", () => {
  const patches = [
    { RECOVERY_EXPECTED_HOST: "elsewhere" }, { RECOVERY_EXPECTED_PORT: "5433" },
    { RECOVERY_EXPECTED_DATABASE: "aroom_pos_operational_elsewhere" }, { RECOVERY_EXPECTED_SCHEMA: "private" },
    { RECOVERY_EXPECTED_USER: "somebody_else" }, { RECOVERY_EXPECTED_SERVER_ADDRESS: "database.example" },
    { RECOVERY_EXPECTED_PORT: "0" }, { RECOVERY_EXPECTED_PORT: "65536" },
    { RECOVERY_DATABASE_URL: targetEnvironment.RECOVERY_DATABASE_URL + "#ambiguous" },
    { RECOVERY_DATABASE_URL: targetEnvironment.RECOVERY_DATABASE_URL + "?options=-csearch_path%3Dprivate" },
    { RECOVERY_DATABASE_URL: targetEnvironment.RECOVERY_DATABASE_URL + "?schema=private" },
    { RECOVERY_DATABASE_URL: targetEnvironment.RECOVERY_DATABASE_URL + "?schema=public&schema=public" },
    { RECOVERY_DATABASE_URL: "postgresql://operator:unused@localhost:5432/aroom_pos", RECOVERY_EXPECTED_DATABASE: "aroom_pos" },
    { RECOVERY_DATABASE_URL: "postgresql://operator:unused@localhost:5432/postgres", RECOVERY_EXPECTED_DATABASE: "postgres" },
    { RECOVERY_DATABASE_URL: "postgresql://operator:unused@localhost:5432/aroom_bootstrap_test_" + "a".repeat(32),
      RECOVERY_EXPECTED_DATABASE: "aroom_bootstrap_test_" + "a".repeat(32) },
  ];
  for (const patch of patches) assert.throws(() => recoveryTarget({ ...targetEnvironment, ...patch }), { code: "INVALID_TARGET" });
});

test("recovery intent accepts only the explicit non-secret operation metadata", () => {
  const input = intent();
  assert.deepEqual(recoveryIntent(input), input);
  for (const invalid of [null, [], {}, { ...input, operationId: "not-a-uuid" }, { ...input, targetUserId: "not-a-uuid" },
    { ...input, expectedVersion: 0 }, { ...input, expectedVersion: 1.5 }, { ...input, expectedVersion: 2147483647 },
    { ...input, expectedVersion: "1" }, { ...input, approvalReference: " " }, { ...input, operatorIdentity: " " },
    { ...input, approvalReference: "a".repeat(257) }, { ...input, operatorIdentity: "a".repeat(257) },
    { ...input, approvalReference: "approval\nforged-line" }, { ...input, operatorIdentity: "operator\u0000" },
    { ...input, password: "must-never-be-intent" }, { ...input, intent: "CREATE_ADMIN" }]) {
    assert.throws(() => recoveryIntent(invalid), { code: "INVALID_INPUT" });
  }
});

test("emergency recovery keeps the 20 to 128 Unicode code-point confirmed-password policy", () => {
  const password = "Owner-private-passphrase-2048!";
  assert.equal(validateRecoveryPassword(password, password), password);
  const unicode = "Kopi senja \u00e9 0123456789 \u{1f319}";
  assert.equal(validateRecoveryPassword(unicode, unicode), unicode);
  const withWhitespace = " leading-and-trailing-password ";
  assert.equal(validateRecoveryPassword(withWhitespace, withWhitespace), withWhitespace);
  const maximumUnicode = "\u{1f319}".repeat(128);
  assert.equal(validateRecoveryPassword(maximumUnicode, maximumUnicode), maximumUnicode);
  for (const invalid of ["a-short-password-12", " ".repeat(30), "a".repeat(129), "\u{1f319}".repeat(129),
    "a distinct malformed password\ud800"]) {
    assert.throws(() => validateRecoveryPassword(invalid, invalid), { code: "INVALID_INPUT" });
  }
  assert.throws(() => validateRecoveryPassword(password, "different"), { code: "INVALID_INPUT" });
});

test("verified host evidence is captured from OS APIs and compared with every expected identity", () => {
  const account = userInfo();
  const env = { RECOVERY_EXPECTED_OS_USERNAME: account.username, RECOVERY_EXPECTED_OS_UID: String(account.uid), RECOVERY_EXPECTED_HOSTNAME: hostname() };
  assert.deepEqual(verifiedHostEvidence(env), { osUsername: account.username, osUid: String(account.uid), hostname: hostname() });
  for (const key of Object.keys(env)) {
    const changed = { ...env } as Record<string, string | undefined>;
    changed[key] += "changed";
    assert.throws(() => verifiedHostEvidence(changed), { code: "IDENTITY_MISMATCH" });
    delete changed[key];
    assert.throws(() => verifiedHostEvidence(changed), { code: "IDENTITY_MISMATCH" });
  }
});

test("recovery invocation requires hidden interactive input and rejects driver debugging that could expose hashes", () => {
  const argv = ["node", "recover-admin.ts"];
  assert.doesNotThrow(() => assertRecoveryInvocation(argv, true, true, {}));
  for (const env of [{ DEBUG: "*" }, { DEBUG: "prisma:driver-adapter:pg" }, { NODE_DEBUG: "net" }, { NODE_DEBUG: "http" }]) {
    assert.throws(() => assertRecoveryInvocation(argv, true, true, env), { code: "INVALID_INPUT" });
  }
  for (const [inputTTY, outputTTY] of [[false, true], [true, false], [undefined, true]]) {
    assert.throws(() => assertRecoveryInvocation(argv, inputTTY, outputTTY, {}), { code: "INVALID_INPUT" });
  }
  assert.throws(() => assertRecoveryInvocation([...argv, "synthetic-secret"], true, true, {}), { code: "INVALID_INPUT" });
});

test("hidden recovery credential input does not echo a secret and cancellation rejects", async () => {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const input = new PassThrough();
  const answer = readPrompt(input, sink, "New recovery credential: ", true);
  input.write("private-emergency-secret\r");
  assert.equal(await answer, "private-emergency-secret");
  assert.equal(output, "New recovery credential: \n");
  const cancelled = readPrompt(input, sink, "Confirm: ", true);
  input.write("another-private-secret\u0003");
  await assert.rejects(cancelled);
  assert.doesNotMatch(output, /private-emergency-secret|another-private-secret/);
  input.destroy(); sink.destroy();
});

test("recovery CLI rejects non-TTY input and all password or target arguments without disclosure", () => {
  for (const args of [[], ["--password", "synthetic-secret-not-for-output"], ["--database", "postgresql://operator:synthetic-secret-not-for-output@localhost:1/aroom_pos"],
    ["--inspect", "--password", "synthetic-secret-not-for-output"]]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "prisma/recover-admin.ts", ...args], {
      encoding: "utf8", windowsHide: true, input: "synthetic-secret-not-for-output\n",
      env: { ...process.env, DATABASE_URL: "postgresql://unused:unused@localhost:1/aroom_pos" },
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /INVALID_INPUT/);
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-secret-not-for-output|postgresql:|unused/);
  }
});
