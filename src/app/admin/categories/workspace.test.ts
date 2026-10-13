import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as domain from "../../../lib/categories/domain";

const require = createRequire(import.meta.url);
type Element = { type: unknown; props: Record<string, unknown> };
const actorId = randomUUID();
const row = { id: randomUUID(), name: "Coffee", displayOrder: 0, active: true, revision: 1 };
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const element = value as Element; return [element, ...elements(element.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (value && typeof value === "object" && "props" in value) return text((value as Element).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id in mocks) return mocks[id]; throw new Error(`Unexpected dependency ${id}`);
  }, ...globals }); return exports;
}
const flush = () => new Promise(setImmediate);
function harness(actions: Record<string, unknown> = {}, storage = new Map<string, string>(), identity = actorId) {
  const slots: unknown[] = []; let index = 0, effectQueued = false;
  const effects: (() => void)[] = [];
  const calls: unknown[] = [];
  const navigator = { onLine: true };
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  const component = load("./workspace.tsx", {
    react: {
      useState: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: unknown) => { slots[i] = value; }]; },
      useRef: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useEffect: (effect: () => void) => { if (!effectQueued) { effects.push(effect); effectQueued = true; } },
    },
    "@/lib/categories/domain": domain,
    "@/lib/categories/actions": {
      listCategoriesAction: async () => ({ success: true, categories: [row] }),
      categoryHistoryAction: async () => ({ success: true, events: [] }),
      saveCategoryAction: async (input: unknown) => { calls.push(input); return { success: true, category: row, replayed: false }; }, ...actions,
    },
  }, { navigator, sessionStorage, crypto: { randomUUID } });
  const render = () => { index = 0; const tree = component.CategoryWorkspace({ actorId: identity, initial: { success: true, categories: [row] } } as never); effects.splice(0).forEach(fn => fn()); return tree; };
  const button = (label: string) => elements(render()).find(e => e.type === "button" && text(e).replace(/\s+/g, " ").trim() === label)!;
  const invoke = (element: Element, key: string, value?: unknown) => (element.props[key] as (value?: unknown) => unknown)(value);
  const click = (label: string) => invoke(button(label), "onClick");
  const field = (label: string, value: string) => {
    const node = elements(render()).find(e => e.type === "label" && text(e).trim() === label)!;
    invoke(elements(node).find(e => e.type === "input")!, "onChange", { target: { value } });
  };
  const submit = () => invoke(elements(render()).find(e => e.type === "form")!, "onSubmit", { preventDefault() {} });
  return { render, button, click, field, submit, calls, storage, navigator, sessionStorage,
    locked: () => elements(render()).find(e => e.type === "fieldset")!.props.disabled };
}
test("category page authorizes before reads and exposes the guarded workspace", async () => {
  let allowed = false, reads = 0;
  const page = load("./page.tsx", { "next/link": { default: "a" }, "./workspace": { CategoryWorkspace: "workspace" },
    "@/lib/auth/authorization": { requireRole: async (role: string) => { assert.equal(role, "ADMIN"); if (!allowed) throw new Error("denied"); return { id: actorId }; } },
    "@/lib/categories/actions": { listCategoriesAction: async () => { reads++; return { success: true, categories: [] }; } },
  });
  await assert.rejects(async () => page.default(), /denied/); assert.equal(reads, 0);
  allowed = true; assert.ok(elements(await page.default()).some(e => e.type === "workspace" && e.props.actorId === actorId));
});
test("category form validates, prevents double clicks and refreshes authoritative data", async () => {
  let finish!: (value: unknown) => void; const requests: unknown[] = [];
  const h = harness({ saveCategoryAction: (value: unknown) => { requests.push(value); return new Promise(resolve => { finish = resolve; }); } });
  h.render(); await flush(); h.field("Nama kategori", "Tea"); h.field("Urutan tampilan", "-1"); h.submit(); assert.equal(requests.length, 0);
  h.field("Urutan tampilan", "2"); h.submit(); h.submit(); assert.equal(requests.length, 1); assert.equal(h.locked(), true);
  assert.equal(h.storage.size, 1);
  finish({ success: true, category: row }); await flush(); assert.equal(h.storage.size, 0); assert.equal(h.locked(), false);
  assert.match(text(h.render()), /Kategori tersimpan/); assert.ok(!text(h.render()).includes("Hapus"));
});
test("uncertain intent survives remount and later rejection; recovery reuses exact request", async () => {
  const storage = new Map<string, string>();
  const h = harness({ saveCategoryAction: async () => { throw new Error("transport"); } }, storage);
  h.render(); await flush(); h.field("Nama kategori", "Tea");
  const staleSubmit = elements(h.render()).find(e => e.type === "form")!.props.onSubmit as (event: unknown) => void;
  h.submit(); await flush(); assert.equal(h.locked(), true);
  const original = JSON.parse(storage.get(`aroom:category:${actorId}`)!);
  staleSubmit({ preventDefault() {} }); await flush();
  assert.deepEqual(JSON.parse(storage.get(`aroom:category:${actorId}`)!), original);
  const retried: unknown[] = [];
  const next = harness({ saveCategoryAction: async (input: unknown) => { retried.push(input); return { success: false, code: "FORBIDDEN" }; } }, storage);
  next.render(); await flush(); await next.click("Pulihkan permintaan");
  assert.deepEqual(retried[0], original); assert.equal(next.locked(), true); assert.equal(storage.size, 1);
  const other = harness({}, storage, randomUUID()); other.render(); await flush(); assert.equal(other.locked(), false);
});
test("offline, unavailable storage and corrupt recovery never send", async () => {
  const h = harness(); h.render(); await flush(); h.field("Nama kategori", "Tea"); h.navigator.onLine = false; h.submit(); assert.equal(h.calls.length, 0);
  h.navigator.onLine = true; h.sessionStorage.setItem = () => { throw new Error("storage blocked"); }; h.submit(); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.locked(), true);
  const corrupt = harness({}, new Map([[`aroom:category:${actorId}`, "bad-json"]])); corrupt.render(); await flush();
  assert.equal(corrupt.locked(), true); assert.equal(corrupt.calls.length, 0);
});
test("stale revision reloads and superseded reads cannot replace newer category data", async () => {
  const h = harness({ saveCategoryAction: async () => ({ success: false, code: "STALE_REVISION" }) });
  h.render(); await flush(); h.click("Ubah Coffee"); h.field("Nama kategori", "Renamed"); h.submit(); await flush();
  assert.equal(h.storage.size, 0); assert.match(text(h.render()), /Kategori baru/); assert.match(text(h.render()), /telah berubah/);
  const reads: ((value: unknown) => void)[] = [];
  const stale = harness({ listCategoriesAction: () => new Promise(resolve => reads.push(resolve)) }); stale.render(); await flush();
  stale.click("Muat ulang kategori"); stale.click("Muat ulang kategori");
  reads[1]({ success: true, categories: [{ ...row, name: "Latest" }] }); await flush();
  reads[0]({ success: true, categories: [{ ...row, name: "Old" }] }); await flush();
  assert.match(text(stale.render()), /Latest/); assert.doesNotMatch(text(stale.render()), /Old/);
});
test("category actions independently authorize and sanitize unexpected errors", async () => {
  let allowed = false, calls = 0;
  const actions = load("../../../lib/categories/actions.ts", {
    "next/navigation": { unstable_rethrow: () => {} }, "../auth/authorization": { requireRole: async (role: string) => { assert.equal(role, "ADMIN"); if (!allowed) throw new Error("denied"); return { id: actorId, role }; } },
    "../db": { prisma: {} }, "./domain": domain,
    "./service": { listCategories: async () => { calls++; throw new Error("private connection details"); }, saveCategory: async () => { calls++; }, categoryHistory: async () => { calls++; } },
  });
  for (const name of ["listCategoriesAction", "saveCategoryAction", "categoryHistoryAction"]) await actions[name]();
  assert.equal(calls, 0); allowed = true;
  const result = await actions.listCategoriesAction(); assert.doesNotMatch(JSON.stringify(result), /private/); assert.equal(calls, 1);
});
