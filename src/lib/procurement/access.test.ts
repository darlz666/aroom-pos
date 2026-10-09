import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as domain from "./domain";

const require = createRequire(import.meta.url);
function load(file: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  runInNewContext(code, { exports, require: (id: string) => { if (id in mocks) return mocks[id]; if (id === "react/jsx-runtime") return require(id); throw new Error(`Unexpected dependency ${id}`); } });
  return exports;
}
test("PROCUREMENT home redirects before register reads; existing role destinations are preserved", async () => {
  let role = "PROCUREMENT", reads = 0;
  const page = load("../../app/page.tsx", {
    "next/navigation": { redirect: (path: string) => { throw new Error(path); } }, "next/link": { default: "a" },
    "@/lib/auth/actions": {}, "@/lib/auth/authorization": { requireUser: async () => ({ role }) },
    "@/lib/shifts/actions": { getActiveShiftAction: async () => { reads++; return { success: false }; } }, "./open-shift-form": {}, "./close-shift-form": {},
  });
  for (const [value, destination] of [["PROCUREMENT", "/procurement"], ["FINANCE", "/finance"], ["STOCK_MANAGEMENT", "/inventory"]]) {
    role = value; await assert.rejects(page.default(), { message: destination });
  }
  assert.equal(reads, 0);
  for (role of ["ADMIN", "CASHIER"]) await page.default();
  assert.equal(reads, 2);
});
test("fresh page and action guards enforce read/workflow/approval permissions and preserve redirects", async () => {
  let user: { id: string; role: string } | null = null;
  const denied = new Error("redirect"), actorId = randomUUID();
  const guards = load("../auth/authorization.ts", { "server-only": {}, "next/navigation": { redirect: () => { throw denied; } }, "./current-user": { getCurrentUser: async () => user } });
  let writes = 0, reads = 0;
  const actions = load("./actions.ts", {
    "next/navigation": { unstable_rethrow: (error: unknown) => { if (error === denied) throw error; } },
    "../auth/authorization": guards, "../db": { prisma: {} }, "./domain": domain,
    "./service": { readProcurement: async (_db: unknown, actor: unknown) => { reads++; assert.equal(actor, user); return {}; },
      saveProcurement: async (_db: unknown, actor: unknown) => { writes++; assert.equal(actor, user); return {}; } },
  });
  const input = { id: randomUUID(), key: randomUUID(), revision: 1, operation: "APPROVE" };
  for (const role of [null, "CASHIER", "STOCK_MANAGEMENT", "PROCUREMENT", "FINANCE", "ADMIN"]) {
    user = role ? { id: actorId, role } : null;
    const canRead = role && ["PROCUREMENT", "FINANCE", "ADMIN"].includes(role);
    if (canRead) await actions.procurementReadAction({}); else await assert.rejects(actions.procurementReadAction({}), error => error === denied);
    if (role === "FINANCE") await actions.procurementDecisionAction(input);
    else await assert.rejects(actions.procurementDecisionAction(input), error => error === denied);
    if (role === "PROCUREMENT") {
      await actions.procurementWriteAction({ ...input, operation: "SUBMIT" });
      assert.equal((await actions.procurementWriteAction(input) as { success: boolean }).success, false);
    } else await assert.rejects(actions.procurementWriteAction(input), error => error === denied);
    if (role === "PROCUREMENT" || role === "ADMIN") await guards.requireProcurementManager();
    else await assert.rejects(guards.requireProcurementManager(), error => error === denied);
  }
  assert.equal(reads, 3); assert.equal(writes, 2);
  user = { id: actorId, role: "FINANCE" };
  assert.equal((await actions.procurementDecisionAction({ ...input, operation: "SUBMIT" }) as { success: boolean }).success, false);
  assert.equal((await actions.procurementDecisionAction({ ...input, actorId: randomUUID() }) as { success: boolean }).success, false);
  assert.equal(writes, 2);
});
