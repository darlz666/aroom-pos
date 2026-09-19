import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as presentation from "../inventory/presentation";
import * as recovery from "../../lib/inventory/recipe-form";

const require = createRequire(import.meta.url);
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(" ").replace(/\s+/g, " ").trim();
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected import ${id}`);
  }, ...globals });
  return exports;
}
const actorId = randomUUID(), productId = randomUUID(), ingredientId = randomUUID();
const initial = { success: true, products: [{ id: productId, name: "Oat latte", active: false, available: false, recipe: { id: randomUUID() } }],
  ingredients: [{ id: ingredientId, name: "Oatmilk", active: true, baseUnit: "ml", weightedAverageUnitCostMicros: "33529412" },
    { id: randomUUID(), name: "Inactive unused", active: false, baseUnit: "g", weightedAverageUnitCostMicros: null }] };
const detail = { productId, productName: "Oat latte", productActive: false, productAvailable: false, recipeId: initial.products[0].recipe.id, revision: 1,
  available: true, total: 3353, costError: null, missingCostIngredientIds: [],
  items: [{ ingredientId, ingredientName: "Oatmilk", active: true, quantity: "100", unit: "ml", weightedAverageUnitCostMicros: "33529412", hpp: 3353 }] };
type Call = { name: string; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void };
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(canEdit = true, storage = new Map<string, string>()) {
  const slots: unknown[] = [], effects: (() => unknown)[] = [], cleanups: (() => void)[] = [], calls: Call[] = [];
  let cursor = 0;
  const navigator = { onLine: true };
  const action = (name: string) => (input?: unknown) => new Promise((resolve, reject) => calls.push({ name, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)), resolve, reject }));
  const loaded = load("./recipe-workspace.tsx", {
    react: {
      useState(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
      useRef(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
      useEffect(effect: () => unknown) { const i = cursor++; if (!(i in slots)) { slots[i] = true; effects.push(effect); } },
    },
    "@/lib/inventory/recipe-actions": Object.fromEntries(["getRecipeAction", "listRecipeOptionsAction", "saveRecipeAction"].map(name => [name, action(name)])),
    "@/lib/inventory/recipe-form": recovery, "../inventory/presentation": presentation,
  }, { navigator, crypto: { randomUUID }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { addEventListener() {}, removeEventListener() {} } });
  const render = () => { cursor = 0; return loaded.RecipeWorkspace({ actorId, canEdit, initial } as never); };
  render(); for (const effect of effects) { const cleanup = effect(); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); }
  await settle();
  const button = (label: string) => { const found = elements(render()).find(e => e.type === "button" && text(e) === label); assert.ok(found, label); return found; };
  const change = (label: string, value: string) => {
    const found = elements(render()).find(e => e.type === "label" && text(e).startsWith(label)); assert.ok(found, label);
    const field = elements(found).find(e => ["select", "input"].includes(String(e.type)))!;
    (field.props.onChange as (event: unknown) => void)({ target: { value } });
  };
  const submitHandler = () => elements(render()).find(e => e.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>;
  return { render, button, change, submitHandler, calls, storage, navigator,
    click: (label: string) => (button(label).props.onClick as () => unknown)(),
    submit: () => submitHandler()({ preventDefault() {} }), unmount: () => cleanups.forEach(fn => fn()) };
}
async function select(h: Awaited<ReturnType<typeof harness>>, recipe = detail) {
  h.change("Produk POS", productId); h.calls.at(-1)!.resolve({ success: true, recipe }); await settle();
}
test("recipe page rejects unauthorized access before reads and Finance has only read controls", async () => {
  let role = "CASHIER", reads = 0;
  const page = load("./page.tsx", {
    "next/link": { default: "a" }, "next/navigation": { redirect() {} }, "@/lib/auth/actions": { logoutAction() {} },
    "@/lib/auth/authorization": { requireRecipeReader: async () => { if (!["ADMIN", "STOCK_MANAGEMENT", "FINANCE"].includes(role)) throw new Error("denied"); return { id: actorId, name: "Staff", role, passwordHash: "secret" }; } },
    "@/lib/inventory/recipe-actions": { listRecipeOptionsAction: async () => { reads++; return initial; } }, "./recipe-workspace": { RecipeWorkspace: "Workspace" },
  });
  for (role of ["CASHIER", "anonymous"]) { await assert.rejects(async () => page.default(), /denied/); assert.equal(reads, 0); }
  for (role of ["ADMIN", "STOCK_MANAGEMENT", "FINANCE"]) {
    const tree = await page.default();
    assert.equal(elements(tree).find(e => e.type === "Workspace")!.props.canEdit, role !== "FINANCE");
    assert.deepEqual(elements(tree).filter(e => e.props.href).map(e => e.props.href), role === "ADMIN" ? ["/admin", "/inventory"] : role === "STOCK_MANAGEMENT" ? ["/inventory"] : []);
    assert.doesNotMatch(JSON.stringify(tree), /passwordHash|secret/);
  }
  const h = await harness(false); await select(h);
  assert.match(text(h.render()), /Akses baca saja.*100 ml.*Rp3.353/);
  assert.equal(elements(h.render()).filter(e => e.type === "form").length, 0);
  assert.doesNotMatch(text(h.render()), /Simpan resep|Tambah bahan/);
});
test("recipe editor uses canonical units, saved HPP, inactive visibility and server-confirmed saves", async () => {
  const h = await harness(); await select(h, { ...detail, items: [{ ...detail.items[0], active: false }] });
  assert.match(text(h.render()), /Produk nonaktif.*Produk tidak tersedia.*HPP resep tersimpan/);
  assert.doesNotMatch(text(h.render()), /Inactive unused/);
  h.change("Jumlah 1", "150");
  const submit = h.submitHandler(), pending = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(h.calls.filter(c => c.name === "saveRecipeAction").length, 1);
  assert.equal(h.storage.size, 1); assert.ok(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled);
  const request = h.calls[1].input as recovery.RecipeSubmission;
  assert.equal(request.expectedRevision, 1); assert.deepEqual(request.items, [{ ingredientId, quantity: "150", unit: "ml" }]);
  assert.deepEqual(Object.keys(request).sort(), ["expectedRevision", "idempotencyKey", "items", "productId"]);
  h.calls[1].resolve({ success: true, saved: { revision: 2 } }); await settle();
  h.calls[2].resolve({ success: true, recipe: { ...detail, revision: 2, total: 5029, items: [{ ...detail.items[0], quantity: "150", hpp: 5029 }] } }); h.calls[3].resolve(initial);
  await pending; assert.equal(h.storage.size, 0); assert.match(text(h.render()), /Resep tersimpan.*Rp5.029/);
});
test("lost response retains exact key and payload through failed retry and reload without automatic write", async () => {
  const h = await harness(); await select(h); const pending = h.submit();
  h.calls[1].reject(new Error("transport secret")); await pending;
  const request = h.calls[1].input;
  assert.match(text(h.render()), /Status penyimpanan belum pasti/); assert.doesNotMatch(text(h.render()), /transport secret/);
  h.change("Jumlah 1", "999"); h.click("Periksa / coba lagi");
  assert.deepEqual(h.calls[2].input, request);
  h.calls[2].resolve({ success: false, code: "FORBIDDEN" }); await settle(); assert.equal(h.storage.size, 1);
  h.unmount(); const restored = await harness(true, h.storage);
  assert.equal(restored.calls.length, 0); restored.click("Periksa / coba lagi"); assert.deepEqual(restored.calls[0].input, request);
  restored.calls[0].resolve({ success: true, saved: { replayed: true } }); await settle();
  restored.calls[1].resolve({ success: true, recipe: detail }); restored.calls[2].resolve(initial); await settle();
  assert.equal(h.storage.size, 0); assert.match(text(restored.render()), /Resep tersimpan/);
});
test("stale edits lock mutations until a successful authoritative reload", async () => {
  const h = await harness(); await select(h); const pending = h.submit();
  h.calls[1].resolve({ success: false, code: "STALE_RECIPE" }); await pending;
  assert.match(text(h.render()), /Resep telah berubah/); assert.equal(h.storage.size, 0);
  await h.submit(); assert.equal(h.calls.length, 2);
  h.click("Muat ulang resep & WAC"); h.calls[2].resolve({ success: false, code: "UNAVAILABLE" }); h.calls[3].resolve(initial); await settle();
  assert.equal(elements(h.render()).filter(e => e.type === "form").length, 0);
  h.click("Muat ulang resep & WAC"); h.calls[4].resolve({ success: true, recipe: { ...detail, revision: 2 } }); h.calls[5].resolve(initial); await settle();
  const next = h.submit(); assert.equal((h.calls[6].input as recovery.RecipeSubmission).expectedRevision, 2);
  h.calls[6].resolve({ success: false, code: "INVALID_QUANTITY" }); await next;
});
test("offline, invalid fields and storage failures prevent writes; damaged recovery blocks replacement", async () => {
  const h = await harness(); await select(h); h.navigator.onLine = false; await h.submit(); assert.equal(h.calls.length, 1);
  h.navigator.onLine = true; h.change("Jumlah 1", "0"); await h.submit(); assert.equal(h.calls.length, 1);
  h.change("Jumlah 1", "100"); h.storage.set = () => { throw new Error("unavailable"); }; await h.submit();
  assert.equal(h.calls.length, 1); assert.match(text(h.render()), /Penyimpanan pemulihan tidak tersedia/);
  const damaged = await harness(true, new Map([[recovery.recipeRecoveryKey(actorId), "invalid JSON"]]));
  assert.equal(damaged.button("Muat ulang resep & WAC").props.disabled, true); assert.equal(damaged.calls.length, 0);
});
test("superseded and unmounted reads cannot replace selection; unknown HPP never displays zero", async () => {
  const h = await harness(); h.change("Produk POS", productId); h.change("Produk POS", productId);
  h.calls[1].resolve({ success: true, recipe: { ...detail, available: false, total: null, items: [{ ...detail.items[0], weightedAverageUnitCostMicros: null, hpp: null }] } }); await settle();
  h.calls[0].resolve({ success: true, recipe: detail }); await settle();
  assert.match(text(h.render()), /HPP belum tersedia.*WAC belum diketahui/); assert.doesNotMatch(text(h.render()), /Rp0|Rp3.353/);
  h.click("Muat ulang resep & WAC"); h.unmount(); h.calls[2].resolve({ success: true, recipe: detail }); h.calls[3].resolve(initial); await settle();
  assert.doesNotMatch(text(h.render()), /Rp3.353/);
});
test("confirmed save followed by a failed refresh reports the read failure and cannot resubmit stale data", async () => {
  const h = await harness(); await select(h); const pending = h.submit(); h.calls[1].resolve({ success: true, saved: {} }); await settle();
  h.calls[2].reject(new Error("read failure")); h.calls[3].resolve(initial); await pending;
  assert.match(text(h.render()), /Resep tersimpan, tetapi data terbaru belum dapat dimuat/);
  assert.equal(h.storage.size, 0); assert.equal(elements(h.render()).filter(e => e.type === "form").length, 0);
});
