import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { UserManagementError } from "./domain";

test("Access Management actions use fresh authenticated actors, safe failures and rethrow redirects", async () => {
  const require = createRequire(import.meta.url);
  const paths = [require.resolve("../auth/authorization"), require.resolve("../db"), require.resolve("./service"), require.resolve("next/navigation")];
  const originals = paths.map(path => require.cache[path]);
  let actor = { id: randomUUID(), role: "ADMIN" };
  const db = {};
  const dto = { id: randomUUID(), name: "Staff", loginIdentifier: "staff", role: "CASHIER", active: true };
  const calls: unknown[] = [];
  let failure: Error | undefined;
  let denied = false;
  const service = (list = false) => async (client: unknown, authenticated: unknown, input?: unknown) => {
    assert.equal(client, db); assert.deepEqual(authenticated, actor); calls.push(input);
    if (failure) throw failure;
    return list ? [dto] : dto;
  };
  try {
    const navigation = require("next/dist/client/components/navigation.react-server");
    const mocks = [{ requireRole: async (role: string) => {
      assert.equal(role, "ADMIN"); if (denied) navigation.redirect("/login"); return actor;
    } }, { prisma: db }, { listUsers: service(true), createUser: service(), changeUserRole: service(), setUserActive: service() }, navigation];
    paths.forEach((path, i) => { require.cache[path] = { id: path, filename: path, loaded: true, exports: mocks[i] } as NodeJS.Module; });
    const actions = await import("./actions");
    assert.deepEqual(await actions.listUsersAction(), { success: true, users: [dto] });
    for (const action of [actions.createUserAction, actions.changeUserRoleAction, actions.setUserActiveAction]) {
      actor = { ...actor, id: randomUUID() };
      const input = { userId: dto.id, role: "CASHIER", actorId: "untrusted" };
      assert.deepEqual(await action(input), { success: true, user: dto });
      assert.equal(calls.at(-1), input);
      for (const code of ["INVALID_INPUT", "INVALID_ROLE", "DUPLICATE_LOGIN", "NOT_FOUND", "SELF_ACCESS_CHANGE", "LAST_ADMIN", "FORBIDDEN"] as const) {
        failure = new UserManagementError(code);
        const result = await action(input);
        assert.equal(result.success, false);
        if (!result.success) { assert.equal(result.code, code); assert.ok(result.error.length > 0); }
      }
      failure = new Error("private database credentials");
      const result = await action(input);
      assert.equal(result.success, false);
      if (!result.success) assert.equal(result.code, "UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(result), /private database credentials/);
      failure = undefined;
    }
    const before = calls.length;
    denied = true;
    for (const action of [actions.listUsersAction, () => actions.createUserAction({}), () => actions.changeUserRoleAction({}), () => actions.setUserActiveAction({})]) {
      await assert.rejects(action(), (error: unknown) => (error as { digest: string }).digest === "NEXT_REDIRECT;replace;/login;307;");
    }
    assert.equal(calls.length, before);
  } finally { paths.forEach((path, i) => { if (originals[i]) require.cache[path] = originals[i]; else delete require.cache[path]; }); }
});
