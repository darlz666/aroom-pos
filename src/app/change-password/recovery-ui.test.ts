import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { validatePassword } from "../../lib/auth/password-validation";

const require = createRequire(import.meta.url);
type Element = { type: unknown; props: Record<string, unknown> };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const e = value as Element; return [e, ...elements(e.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value && typeof value === "object" && "props" in value) return text((value as Element).props.children);
  return typeof value === "string" ? value : "";
}
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id in mocks) return mocks[id]; throw new Error(`Unexpected import ${id}`);
  }, ...globals }); return exports;
}
const flush = () => new Promise(setImmediate);
const status = { userId: randomUUID(), credentialsVersion: 1, state: "NORMAL", operation: "NOT_FOUND", expiresAt: null };
function harness(kind: "reset" | "change", actions: Record<string, unknown> = {}, mandatory = false) {
  const slots: unknown[] = []; let cursor = 0;
  const calls: unknown[] = [], copied: string[] = [], navigation: string[] = [];
  const navigator = { onLine: true, clipboard: { writeText: async (value: string) => { copied.push(value); } } };
  const timers: (() => void)[] = [];
  const component = load(kind === "reset" ? "../admin/users/reset-password-panel.tsx" : "./password-change-form.tsx", {
    react: {
      useState: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: unknown) => { slots[i] = value; }]; },
      useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect: (fn: () => void) => fn(),
    },
    "next/link": { default: "a" },
    "next/navigation": { useRouter: () => ({ replace: (path: string) => navigation.push(path), refresh: () => {} }) },
    "@/lib/auth/password-validation": { validatePassword },
    "@/lib/auth/actions": { logoutAction: async () => ({ success: true }) },
    "@/lib/auth/recovery-actions": {
      resetStatusAction: async () => ({ success: true, status }),
      resetPasswordAction: async (input: unknown) => { calls.push(input); return { success: true, status: { ...status, credentialsVersion: 2, state: "TEMPORARY", operation: "APPLIED", expiresAt: new Date(Date.now() + 1800000).toISOString() }, temporaryPassword: "private-generated-fixture" }; },
      changePasswordAction: async (input: unknown) => { calls.push(input); return { success: true }; }, ...actions,
    },
  }, { navigator, window: { location: { assign: (path: string) => navigation.push(path) } }, crypto: { randomUUID },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    FormData: class { constructor(private form: { data: Record<string, unknown> }) {} get(key: string) { return this.form.data[key] ?? null; } },
    localStorage: new Proxy({}, { get() { throw new Error("Credential storage prohibited"); } }), sessionStorage: new Proxy({}, { get() { throw new Error("Credential storage prohibited"); } }),
  });
  const render = () => { cursor = 0; return kind === "reset" ? component.ResetPasswordPanel({ userId: status.userId, name: "Staff", close: () => {} } as never) : component.PasswordChangeForm({ mandatory } as never); };
  const button = (label: string) => elements(render()).find(e => e.type === "button" && text(e).trim() === label)!;
  const click = async (label: string) => { await (button(label).props.onClick as () => Promise<void>)(); await flush(); };
  let cleared = 0;
  const submit = (data: Record<string, unknown>) => (elements(render()).find(e => e.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: { data, reset: () => { cleared++; } } });
  return { render, click, submit, calls, copied, navigation, navigator, timers, cleared: () => cleared };
}

test("reset requires status inspection, blocks duplicate sends, displays once and copies only on deliberate action", async () => {
  let finish!: (value: unknown) => void; const requests: unknown[] = [];
  const h = harness("reset", { resetPasswordAction: (input: unknown) => { requests.push(input); return new Promise(resolve => { finish = resolve; }); } });
  await h.submit({ adminPassword: "owner-private" }); assert.equal(requests.length, 0);
  await h.click("Periksa status server");
  const pending = h.submit({ adminPassword: "owner-private" }); await h.submit({ adminPassword: "owner-private" });
  assert.equal(requests.length, 1); assert.equal(h.cleared(), 1);
  finish({ success: true, status: { ...status, state: "TEMPORARY", expiresAt: new Date(Date.now() + 1800000).toISOString() }, temporaryPassword: "one-time-secret" }); await pending;
  assert.match(text(h.render()), /one-time-secret/); assert.equal(h.copied.length, 0);
  await h.click("Salin password"); assert.deepEqual(h.copied, ["one-time-secret"]);
  await h.click("Sembunyikan permanen"); assert.doesNotMatch(text(h.render()), /one-time-secret/);
  await h.submit({ adminPassword: "owner-private" }); assert.equal(requests.length, 1);
});
test("lost reset response locks writes until authoritative status; explicit reissue uses new operation and version", async () => {
  const requests: { operationId: string; expectedVersion: number }[] = []; let version = 1;
  const h = harness("reset", {
    resetStatusAction: async () => ({ success: true, status: { ...status, credentialsVersion: version, operation: version === 1 ? "NOT_FOUND" : "APPLIED" } }),
    resetPasswordAction: async (input: { operationId: string; expectedVersion: number }) => { requests.push(input); version++; throw new Error("lost response"); },
  });
  await h.click("Periksa status server"); await h.submit({ adminPassword: "private" });
  await h.submit({ adminPassword: "private" }); assert.equal(requests.length, 1);
  await h.click("Periksa status server"); assert.match(text(h.render()), /tidak dapat ditampilkan ulang/);
  await h.submit({ adminPassword: "private" }); assert.equal(requests.length, 2);
  assert.notEqual(requests[0].operationId, requests[1].operationId); assert.equal(requests[1].expectedVersion, 2);
});
test("temporary password display expires and offline reset never sends", async () => {
  const h = harness("reset"); await h.click("Periksa status server"); h.navigator.onLine = false;
  await h.submit({ adminPassword: "private" }); assert.equal(h.calls.length, 0);
  h.navigator.onLine = true; await h.submit({ adminPassword: "private" }); h.render();
  assert.ok(h.timers.length); h.timers.at(-1)!();
  assert.doesNotMatch(text(h.render()), /private-generated-fixture/); assert.match(text(h.render()), /kedaluwarsa/);
});
test("mandatory change has no normal navigation; validation and uncertain-result handling preserve secrets", async () => {
  const h = harness("change", { changePasswordAction: async () => { throw new Error("lost response"); } }, true);
  assert.ok(!elements(h.render()).some(e => e.props.href === "/" || e.props.name === "currentPassword"));
  await h.submit({ newPassword: "short", confirmation: "short" }); assert.match(text(h.render()), /12–128/);
  await h.submit({ newPassword: "unique-private-password", confirmation: "unique-private-password" });
  assert.equal(h.cleared(), 1); assert.match(text(h.render()), /Hasil belum pasti/);
  await h.submit({ newPassword: "unique-private-password", confirmation: "unique-private-password" }); assert.equal(h.cleared(), 1);
  assert.doesNotMatch(text(h.render()), /unique-private-password/);
  await h.click("Keluar"); assert.deepEqual(h.navigation, ["/login"]);
  await flush();
});
test("voluntary change includes current password and successful replacement requires login", async () => {
  const h = harness("change"); assert.ok(elements(h.render()).some(e => e.props.name === "currentPassword"));
  await h.submit({ currentPassword: "old-private", newPassword: "new-private-password", confirmation: "new-private-password" });
  assert.equal(h.calls.length, 1); assert.deepEqual(h.navigation, ["/login"]); assert.equal(h.cleared(), 1);
});
test("change page checks restricted identity before rendering and redirects expired/absent identity", async () => {
  let allowed = false;
  const page = load("./page.tsx", { "next/navigation": { redirect: () => { throw new Error("login"); } },
    "@/lib/auth/current-user": { getPasswordChangeUser: async () => allowed ? { mustChangePassword: true } : null }, "./password-change-form": { PasswordChangeForm: "form" } });
  await assert.rejects(async () => page.default(), /login/); allowed = true;
  assert.ok(elements(await page.default()).some(e => e.type === "form" && e.props.mandatory === true));
});
