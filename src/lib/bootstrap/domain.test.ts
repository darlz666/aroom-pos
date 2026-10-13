import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { bootstrapInput, bootstrapTarget } from "./domain";
import { readPrompt } from "./prompt";

test("bootstrap target is explicit, bounded and never falls back to DATABASE_URL", () => {
  const env = { BOOTSTRAP_DATABASE_URL: "postgresql://operator:unused@localhost:5432/aroom_pos_operational_launch", BOOTSTRAP_EXPECTED_HOST: "localhost",
    BOOTSTRAP_EXPECTED_PORT: "5432", BOOTSTRAP_EXPECTED_DATABASE: "aroom_pos_operational_launch", BOOTSTRAP_EXPECTED_USER: "operator" };
  assert.equal(bootstrapTarget(env).database, "aroom_pos_operational_launch");
  assert.equal(bootstrapTarget({ ...env, BOOTSTRAP_DATABASE_URL: env.BOOTSTRAP_DATABASE_URL + "?schema=public" }).database, "aroom_pos_operational_launch");
  assert.throws(() => bootstrapTarget({ DATABASE_URL: env.BOOTSTRAP_DATABASE_URL }), { code: "INVALID_TARGET" });
  for (const patch of [{ BOOTSTRAP_EXPECTED_HOST: "wrong" }, { BOOTSTRAP_EXPECTED_PORT: "5433" }, { BOOTSTRAP_EXPECTED_DATABASE: "wrong" },
    { BOOTSTRAP_EXPECTED_USER: "wrong" }, { BOOTSTRAP_DATABASE_URL: env.BOOTSTRAP_DATABASE_URL + "?options=unsafe" },
    { BOOTSTRAP_DATABASE_URL: env.BOOTSTRAP_DATABASE_URL + "?schema=other" },
    { BOOTSTRAP_DATABASE_URL: "postgresql://operator:unused@localhost/aroom_pos", BOOTSTRAP_EXPECTED_DATABASE: "aroom_pos" }]) {
    assert.throws(() => bootstrapTarget({ ...env, ...patch }), { code: "INVALID_TARGET" });
  }
});
test("bootstrap requires a strong confirmed password without changing shared password rules", () => {
  const password = "Owner-private-passphrase-2048!";
  assert.deepEqual(bootstrapInput(" Owner ", " OWNER ", password, password), { name: "Owner", loginIdentifier: "owner", password });
  for (const weak of ["short", "a".repeat(24), " ".repeat(30), " leading-and-trailing-password ", "a".repeat(129)]) {
    assert.throws(() => bootstrapInput("Owner", "owner", weak, weak), { code: "INVALID_INPUT" });
  }
  assert.throws(() => bootstrapInput("Owner", "owner", password, "different"), { code: "INVALID_INPUT" });
});
test("hidden prompt never echoes typed passwords and handles cancellation", async () => {
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const input = new PassThrough();
  const answer = readPrompt(input, sink, "Password: ", true);
  input.write("private-password\r");
  assert.equal(await answer, "private-password");
  assert.equal(output, "Password: \n");
  const cancelled = readPrompt(input, sink, "Password: ", true);
  input.write("secret\u0003");
  await assert.rejects(cancelled);
  assert.doesNotMatch(output, /secret|private-password/);
  input.destroy(); sink.destroy();
});
test("CLI refuses redirected input and password arguments without disclosing them", () => {
  for (const args of [[], ["--password", "synthetic-secret-not-for-output"]]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--conditions=react-server", "prisma/bootstrap-admin.ts", ...args], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://unused:unused@localhost:1/unused" },
      input: "synthetic-secret-not-for-output\n", windowsHide: true,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /INVALID_INPUT/);
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-secret-not-for-output|postgresql:|unused/);
  }
});
