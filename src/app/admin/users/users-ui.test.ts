import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as Element;
  return [e, ...elements(e.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(" ").replace(/\s+/g, " ").trim();
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children);
  return typeof node === "string" ? node : "";
}
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected import: ${id}`);
  }, ...globals });
  return exports;
}
const admin = { id: "admin", name: "Admin", loginIdentifier: "admin", role: "ADMIN", active: true };
const staff = { id: "staff", name: "Staff", loginIdentifier: "staff", role: "CASHIER", active: true };
function harness(initial: unknown = { success: true, users: [admin, staff] }) {
  const slots: unknown[] = [];
  let cursor = 0;
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const calls: { name: string; input: unknown }[] = [];
  const action = (name: string) => (input: unknown) => {
    calls.push({ name, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  };
  const component = load("./users-panel.tsx", {
    react: {
      useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
        return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
      useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    },
    "@/lib/users/domain": { userRoles: ["ADMIN", "CASHIER", "STOCK_MANAGEMENT", "FINANCE"] },
    "@/lib/users/actions": { createUserAction: action("create"), listUsersAction: action("list"),
      changeUserRoleAction: action("role"), setUserActiveAction: action("active") },
  }, { FormData: class { constructor(private form: { data: Record<string, unknown> }) {} get(key: string) { return this.form.data[key]; } } });
  const render = () => { cursor = 0; return component.UsersPanel({ actorId: "admin", initial } as never); };
  const button = (label: string) => elements(render()).find(e => e.type === "button" && text(e) === label)!;
  const click = (label: string) => (button(label).props.onClick as () => Promise<unknown>)();
  return { render, button, click, calls, resolve: (value: unknown) => resolve(value), reject: () => reject(new Error("private transport")) };
}
test("user management page guards before listing and admin navigation is reachable", async () => {
  let allowed = false, reads = 0;
  const page = load("./page.tsx", {
    "next/link": { default: "a" },
    "@/lib/auth/authorization": { requireRole: async (role: string) => { assert.equal(role, "ADMIN"); if (!allowed) throw new Error("denied"); return admin; } },
    "@/lib/users/actions": { listUsersAction: async () => { reads++; return { success: true, users: [admin] }; } },
    "./users-panel": { UsersPanel: "UsersPanel" },
  });
  await assert.rejects(async () => page.default(), /denied/); assert.equal(reads, 0);
  allowed = true;
  const tree = await page.default();
  assert.equal(reads, 1);
  const panel = elements(tree).find(e => e.type === "UsersPanel")!;
  assert.deepEqual(Object.keys(panel.props).sort(), ["actorId", "initial"]);
  assert.ok(elements(tree).some(e => e.props.href === "/admin"));
  const adminPage = load("../page.tsx", {
    "next/link": { default: "a" }, "@/lib/auth/authorization": { requireRole: async () => admin },
  });
  const links = elements(await adminPage.default()).filter(e => e.props.href).map(e => e.props.href);
  assert.deepEqual(links, ["/admin/users", "/admin/reports", "/"]);
});
test("all roles and statuses display with self-access controls disabled", () => {
  const h = harness();
  assert.match(text(h.render()), /Admin \(Anda\).*ADMIN.*Aktif.*Staff.*CASHIER/);
  assert.equal(elements(h.render()).filter(e => e.type === "option").length, 12);
  const articles = elements(h.render()).filter(e => e.type === "article");
  assert.equal(elements(articles[0]).find(e => e.type === "fieldset")!.props.disabled, true);
  assert.equal(elements(articles[1]).find(e => e.type === "fieldset")!.props.disabled, false);
  assert.equal(elements(h.render()).find(e => e.props.name === "password")!.props.type, "password");
});
test("rapid duplicate mutations are blocked, server status controls reactivation", async () => {
  const h = harness();
  const click = h.button("Nonaktifkan Staff").props.onClick as () => Promise<unknown>;
  const pending = click(); await click();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { name: "active", input: { userId: "staff", active: false } });
  assert.ok(elements(h.render()).filter(e => e.type === "fieldset").every(e => e.props.disabled));
  h.resolve({ success: true, user: { ...staff, active: false } }); await pending;
  assert.match(text(h.render()), /Nonaktif/);
  const next = h.click("Aktifkan Staff");
  assert.deepEqual(h.calls[1].input, { userId: "staff", active: true });
  h.resolve({ success: true, user: staff }); await next;
  assert.match(text(h.render()), /Perubahan disimpan/);
});
test("uncertain writes and failed reloads block mutations until authoritative list reload", async () => {
  for (const transport of [false, true]) {
    const h = harness();
    const pending = h.click("Nonaktifkan Staff");
    if (transport) h.reject(); else h.resolve({ success: false, code: "UNAVAILABLE", error: "Periksa koneksi" });
    await pending;
    assert.doesNotMatch(text(h.render()), /private transport/);
    assert.ok(elements(h.render()).filter(e => e.type === "fieldset").every(e => e.props.disabled));
    await h.click("Nonaktifkan Staff"); assert.equal(h.calls.length, 1);
    let reload = h.click("Muat ulang daftar");
    h.resolve({ success: false, code: "UNAVAILABLE", error: "Periksa koneksi" }); await reload;
    assert.ok(elements(h.render()).filter(e => e.type === "fieldset").every(e => e.props.disabled));
    reload = h.click("Muat ulang daftar");
    h.resolve({ success: true, users: [admin, { ...staff, active: false }] }); await reload;
    assert.match(text(h.render()), /Aktifkan Staff/);
    assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, false);
  }
});
test("creation sends only allowed input, clears password, blocks duplicates and resets on success", async () => {
  const h = harness();
  let reset = 0;
  const password = { value: "long password" };
  const form = { data: { name: "New", loginIdentifier: "new", password: password.value, role: "FINANCE", actorId: "forged" },
    elements: { namedItem: () => password }, reset: () => { reset++; } };
  const submit = elements(h.render()).find(e => e.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>;
  const event = { preventDefault() {}, currentTarget: form };
  const pending = submit(event); await submit(event);
  assert.equal(password.value, ""); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].input, { name: "New", loginIdentifier: "new", password: "long password", role: "FINANCE" });
  h.resolve({ success: true, user: { ...staff, id: "new", name: "New", role: "FINANCE" } }); await pending;
  assert.equal(reset, 1); assert.match(text(h.render()), /New.*FINANCE/);
});
test("initial loading failure offers retry; role change validation remains editable", async () => {
  const h = harness({ success: false, code: "UNAVAILABLE", error: "Periksa koneksi" });
  assert.match(text(h.render()), /Periksa koneksi/);
  assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, true);
  const pending = h.click("Muat ulang daftar");
  h.resolve({ success: true, users: [admin, staff] }); await pending;
  const forms = elements(h.render()).filter(e => e.type === "form");
  (forms[2].props.onSubmit as (event: unknown) => void)({ preventDefault() {}, currentTarget: { data: { role: "FINANCE" } } });
  assert.deepEqual(h.calls[1], { name: "role", input: { userId: "staff", role: "FINANCE" } });
  h.resolve({ success: false, code: "LAST_ADMIN", error: "Setidaknya satu ADMIN harus tetap aktif." });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(h.render()), /Setidaknya satu ADMIN/);
  assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, false);
});
