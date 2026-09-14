import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
// Compile real components with isolated boundary mocks; no app/database writes.
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(source(file), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected component dependency: ${id}`);
  }, ...globals });
  return exports;
}


function harness(action: (input: unknown) => Promise<unknown>, requiresAdminReason = false) {
  const slots: unknown[] = [];
  let cursor = 0;
  let refreshes = 0;
  const component = load("./close-shift-form.tsx", {
    react: {
      useRef: (value: unknown) => { const i = cursor++; return slots[i] ??= { current: value }; },
      useState: (value: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: unknown) => { slots[i] = next; }]; },
      useTransition: () => [false, (fn: () => void) => fn()],
      useEffect: (fn: () => void) => fn(),
    },
    "next/navigation": { useRouter: () => ({ refresh: () => { refreshes++; } }) },
    "@/lib/shifts/close-action": { closeShiftAction: action },
  });
  const render = () => { cursor = 0; return component.CloseShiftForm({ shiftId: "shift", requiresAdminReason } as never); };
  const change = (id: string, value: string) => {
    const field = elements(render()).find(e => e.props.id === id)!;
    (field.props.onChange as (event: unknown) => void)({ target: { value } });
  };
  const submit = (tree = render()) => (elements(tree)[0].props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  return { render, change, submit, refreshes: () => refreshes };
}

test("cash syntax rejects malformed values without action; zero reviews then confirms; no optimistic close", async () => {
  let calls = 0;
  let finish!: (result: unknown) => void;
  const h = harness(async input => { calls++; assert.equal((input as { countedCash: string }).countedCash, "0"); return new Promise(resolve => { finish = resolve; }); });
  for (const cash of ["", "-1", "1.5", "1e3", "1,000", "1.000", " 0", "0 ", "Infinity"]) {
    h.change("counted-cash", cash);
    await h.submit();
    assert.match(text(h.render()), /tanpa tanda atau pemisah/);
  }
  assert.equal(calls, 0);
  h.change("counted-cash", "0");
  await h.submit();
  assert.equal(calls, 0);
  assert.match(text(h.render()), /Server akan menghitung/);
  const review = h.render();
  const pending = h.submit(review);
  await h.submit(review);
  assert.equal(calls, 1);
  assert.equal(h.refreshes(), 0);
  assert.doesNotMatch(text(h.render()), /berhasil ditutup/);
  assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, true);
  finish({ success: true });
  await pending;
  assert.equal(h.refreshes(), 1);
  assert.match(text(h.render()), /berhasil ditutup/);
  await h.submit();
  assert.equal(calls, 1);
});

test("admin reason is required only for ADMIN_VIEW; blank reason blocks review", async () => {
  for (const admin of [false, true]) {
    let calls = 0;
    const h = harness(async () => { calls++; return { success: false, code: "REASON_REQUIRED", error: "Isi alasan admin menutup shift." }; }, admin);
    assert.equal(elements(h.render()).some(e => e.props.id === "admin-close-reason"), admin);
    h.change("counted-cash", "0");
    if (admin) {
      h.change("admin-close-reason", "  ");
      await h.submit();
      assert.match(text(h.render()), /Isi alasan admin/);
      assert.equal(calls, 0);
      h.change("admin-close-reason", "Bantuan penutupan");
    }
    await h.submit();
    assert.equal(calls, 0);
    if (admin) {
      await h.submit();
      assert.equal(elements(h.render()).find(e => e.props.id === "admin-close-reason")!.props["aria-invalid"], true);
    }
  }
});

test("server errors preserve inputs and associate errors; stale shift refreshes", async () => {
  for (const code of ["DISCREPANCY_NOTE_REQUIRED", "INVALID_MONEY", "UNRESOLVED_TRANSACTIONS", "FORBIDDEN", "SHIFT_NOT_OPEN"]) {
    const h = harness(async () => ({ success: false, code, error: "Pesan aman dari server" }));
    h.change("counted-cash", "123");
    await h.submit(); await h.submit();
    const tree = h.render();
    assert.equal(elements(tree).find(e => e.props.id === "counted-cash")!.props.value, "123");
    assert.match(text(tree), /Pesan aman/);
    assert.equal(h.refreshes(), code === "SHIFT_NOT_OPEN" ? 1 : 0);
    if (code === "DISCREPANCY_NOTE_REQUIRED") {
      assert.equal(elements(tree).find(e => e.props.id === "discrepancy-note")!.props["aria-invalid"], true);
      h.change("discrepancy-note", "Selisih dihitung ulang");
      await h.submit();
      assert.match(text(h.render()), /Konfirmasi penutupan/);
    }
  }
});

test("interrupted requests expose only safe retry guidance and reload", async () => {
  const h = harness(async () => { throw new Error("SECRET database password"); });
  h.change("counted-cash", "0"); await h.submit(); await h.submit();
  assert.match(text(h.render()), /belum dapat dipastikan/);
  assert.doesNotMatch(text(h.render()), /SECRET|database|password/);
  assert.ok(elements(h.render()).some(e => e.type === "a" && e.props.href === "/"));
});

test("action uses authenticated actor, whitelists input/result, and safely maps every domain error", async () => {
  const { ShiftError, parseShiftMoney } = await import("../lib/shifts/domain");
  let authenticated = true;
  let failure: unknown;
  let calls = 0;
  const actor = { id: "trusted", role: "CASHIER" };
  const action = load("../lib/shifts/close-action.ts", {
    "../auth/authorization": { requireUser: async () => { if (!authenticated) throw new Error("login"); return actor; } },
    "../db": { prisma: {} },
    "./domain": { ShiftError, parseShiftMoney },
    "./service": { closeShift: async (_db: unknown, receivedActor: unknown, input: Record<string, unknown>) => {
      calls++;
      assert.equal(receivedActor, actor);
      assert.deepEqual(Object.keys(input).sort(), ["adminCloseReason", "countedCash", "discrepancyNote", "shiftId"]);
      assert.equal(input.countedCash, 0);
      if (failure) throw failure;
      return { expectedCash: 0, countedCash: 0, cashVariance: 0, closedAt: "2026-09-14T00:00:00Z", id: "private", adminCloseReason: "private" };
    } },
  });
  const input = { shiftId: "shift", countedCash: "0", discrepancyNote: "", adminCloseReason: "", actor: { role: "ADMIN" }, id: "forged", role: "ADMIN" };
  const run = () => action.closeShiftAction(input as never) as Promise<Record<string, unknown>>;
  const success = await run();
  assert.deepEqual(Object.keys(success).sort(), ["cashVariance", "closedAt", "countedCash", "expectedCash", "success"]);
  for (const code of ["SHIFT_NOT_OPEN", "FORBIDDEN", "INVALID_MONEY", "REASON_REQUIRED", "DISCREPANCY_NOTE_REQUIRED", "UNRESOLVED_TRANSACTIONS", "INVALID_INPUT", "REGISTER_OCCUPIED"] as const) {
    failure = new ShiftError(code);
    const result = await run();
    assert.equal(result.success, false);
    assert.equal(result.code, code);
    assert.doesNotMatch(String(result.error), /private|SELECT|stack/);
    if (code === "UNRESOLVED_TRANSACTIONS") assert.match(String(result.error), /pesanan atau pembayaran yang belum selesai/);
  }
  failure = new Error("private DB credentials");
  assert.doesNotMatch(JSON.stringify(await run()), /private|credentials/);
  authenticated = false;
  const before = calls;
  await assert.rejects(run, /login/);
  assert.equal(calls, before);
});

test("client contains no authoritative reconciliation calculation or sensitive data", () => {
  const form = source("./close-shift-form.tsx");
  assert.doesNotMatch(form, /expectedCash|cashVariance|openingCash|calculateExpectedCash|password|session|token|prisma/);
  assert.match(form, /inputMode="numeric"/);
  assert.match(form, /aria-live="polite"/);
});
