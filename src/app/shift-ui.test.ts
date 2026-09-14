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

test("root authenticates first and renders only permitted state and staff fields", async () => {
  let authenticated = false;
  let reads = 0;
  let role = "CASHIER";
  let state: Record<string, unknown> = { success: true, state: "EMPTY" };
  const OpenShiftForm = () => null;
  const page = load("./page.tsx", {
    "next/navigation": { redirect() {} },
    "@/lib/auth/authorization": { requireUser: async () => {
      if (!authenticated) throw new Error("redirect login");
      return { name: "Staff", role, id: "private-id", passwordHash: "private-hash", session: "private-session", token: "private-token", loginIdentifier: "private-login" };
    } },
    "@/lib/auth/actions": { logoutAction() {} },
    "@/lib/shifts/actions": { getActiveShiftAction: async () => { reads++; return state; } },
    "./open-shift-form": { OpenShiftForm },
  });
  await assert.rejects(async () => page.default(), /redirect login/);
  assert.equal(reads, 0);
  authenticated = true;
  const empty = await page.default();
  assert.ok(elements(empty).some(e => e.type === OpenShiftForm && Object.keys(e.props).length === 0));
  assert.match(text(empty), /Buka shift terlebih dahulu/);
  for (const mode of ["OWNED", "OCCUPIED", "ADMIN_VIEW", "ADMIN_OWNED"]) {
    role = mode.startsWith("ADMIN") ? "ADMIN" : "CASHIER";
    const occupied = mode === "OCCUPIED";
    const shift = { ownerName: "<script>Owner</script>", openedAt: "2026-09-10T18:30:00.000Z", ownsShift: mode === "OWNED" || mode === "ADMIN_OWNED" };
    if (occupied) Object.defineProperty(shift, "openingCash", { get() { throw new Error("Cash must never be accessed"); } });
    state = { success: true, state: mode === "ADMIN_OWNED" ? "OWNED" : mode, shift: occupied ? shift : { ...shift, openingCash: 123456 } };
    const tree = await page.default();
    const rendered = text(tree);
    assert.match(rendered, /Logout/);
    assert.match(rendered, /11 September 2026/);
    assert.match(rendered, /01[.:]30/);
    assert.doesNotMatch(rendered, /private-/);
    assert.ok(elements(tree).every(e => !("dangerouslySetInnerHTML" in e.props)));
    if (occupied) {
      assert.doesNotMatch(rendered, /Kas awal|123[.]456|POS akan dilanjutkan/);
      assert.match(rendered, /Tunggu hingga shift aktif ditutup/);
    } else {
      assert.match(rendered, /Shift Aktif/);
      assert.match(rendered, /Rp 123.456/);
      assert.match(rendered, /POS akan dilanjutkan pada milestone berikutnya/);
      if (mode === "ADMIN_VIEW") {
        assert.match(rendered, /Mode bantuan admin/);
        assert.doesNotMatch(rendered, /Shift Anda aktif/);
      } else {
        assert.doesNotMatch(rendered, /Mode bantuan admin/);
        assert.match(rendered, /Shift Anda aktif/);
      }
    }
    assert.equal(elements(tree).filter(e => e.type === "button").length, 1);
  }
  state = { success: false, error: "Shift belum dapat diproses." };
  const unavailable = await page.default();
  assert.match(text(unavailable), /Muat ulang/);
  assert.ok(!elements(unavailable).some(e => e.type === OpenShiftForm));
});

function formHarness(action: (value: unknown) => Promise<unknown>) {
  const slots: unknown[] = [];
  let cursor = 0;
  let refreshes = 0;
  const component = load("./open-shift-form.tsx", {
    react: {
      useRef: (value: unknown) => { const i = cursor++; return slots[i] ??= { current: value }; },
      useState: (value: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: unknown) => { slots[i] = next; }]; },
      useTransition: () => [false, (fn: () => void) => fn()],
    },
    "next/navigation": { useRouter: () => ({ refresh: () => { refreshes++; } }) },
    "@/lib/shifts/actions": { openShiftAction: action },
  }, { FormData: class { constructor(private value: unknown) {} get() { return this.value; } } });
  const render = () => { cursor = 0; return component.OpenShiftForm(); };
  const submit = (tree: unknown, value: unknown) => (elements(tree)[0].props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {}, currentTarget: value });
  return { render, submit, refreshes: () => refreshes };
}

test("form rejects ambiguous money without calling the action; zero submits unchanged", async () => {
  const calls: unknown[] = [];
  const h = formHarness(async value => { calls.push(value); return { success: false, error: "Nominal kas awal tidak valid.", code: "INVALID_MONEY" }; });
  for (const value of ["", "-1", "1.5", "1e5", "1,000", "1.000", " 0", "0 "]) {
    await h.submit(h.render(), value);
    assert.match(text(h.render()), /tanpa tanda atau pemisah/);
  }
  assert.deepEqual(calls, []);
  await h.submit(h.render(), "0");
  assert.deepEqual(calls, ["0"]);
  assert.equal(h.refreshes(), 0);
  const input = elements(h.render()).find(e => e.type === "input")!;
  assert.equal(input.props.type, "text");
  assert.equal(input.props.inputMode, "numeric");
  assert.equal(input.props["aria-invalid"], true);
});

test("in-flight duplicate submissions are blocked; CREATED and EXISTING refresh authoritative state", async () => {
  for (const state of ["CREATED", "EXISTING"]) {
    let finish!: (value: unknown) => void;
    let calls = 0;
    const h = formHarness(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const initial = h.render();
    const pending = h.submit(initial, "0");
    await h.submit(initial, "0");
    assert.equal(calls, 1);
    assert.equal(h.refreshes(), 0);
    assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, true);
    finish({ success: true, state, shift: { openingCash: "SHOULD_NOT_RENDER" } });
    await pending;
    const confirmed = h.render();
    assert.equal(h.refreshes(), 1);
    assert.doesNotMatch(text(confirmed), /SHOULD_NOT_RENDER|Shift Aktif/);
    await h.submit(confirmed, "0");
    assert.equal(calls, 1);
  }
});

test("controlled occupied error is rendered and refreshes; unexpected errors remain safe and retryable", async () => {
  const h = formHarness(async () => ({ success: false, code: "REGISTER_OCCUPIED", error: "Register sedang digunakan oleh shift lain." }));
  await h.submit(h.render(), "0");
  assert.match(text(h.render()), /Register sedang digunakan/);
  assert.equal(h.refreshes(), 1);
  const failed = formHarness(async () => { throw new Error("private password token database"); });
  await failed.submit(failed.render(), "0");
  const tree = failed.render();
  assert.match(text(tree), /belum dapat dipastikan/);
  assert.doesNotMatch(text(tree), /private|password|token|database/);
  assert.equal(elements(tree).find(e => e.type === "fieldset")!.props.disabled, false);
  assert.ok(elements(tree).some(e => e.props["aria-live"] === "polite"));
});

test("UI has no close/order/payment action or sensitive client props and retains secure logout", () => {
  const page = source("./page.tsx");
  const form = source("./open-shift-form.tsx");
  assert.doesNotMatch(page, /use client/);
  assert.match(page, /await requireUser\(\);\s*const register = await getActiveShiftAction\(\)/);
  assert.match(page, /await logoutAction\(\);\s*redirect\("\/login"\)/);
  assert.doesNotMatch(page + form, /closeShift|createOrder|paymentAction|passwordHash|sessionToken|dangerouslySetInnerHTML/);
  assert.match(form, /import \{ openShiftAction \} from "@\/lib\/shifts\/actions"/);
  assert.match(page, /<OpenShiftForm \/>/);
});
