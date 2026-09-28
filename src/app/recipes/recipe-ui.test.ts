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
const initial = { success: true, categories: [{ id: randomUUID(), name: "Coffee" }], products: [{ id: productId, name: "Oat latte", active: false, available: false, recipe: { id: randomUUID() } }],
  ingredients: [{ id: ingredientId, name: "Oatmilk", active: true, baseUnit: "ml", weightedAverageUnitCostMicros: "33529412" },
    { id: randomUUID(), name: "Inactive unused", active: false, baseUnit: "g", weightedAverageUnitCostMicros: null }] };
const detail = { productId, productName: "Oat latte", productActive: false, productAvailable: false, recipeId: initial.products[0].recipe.id, revision: 1,
  available: true, total: 3353, costError: null, missingCostIngredientIds: [],
  items: [{ ingredientId, ingredientName: "Oatmilk", active: true, quantity: "100", unit: "ml", weightedAverageUnitCostMicros: "33529412", hpp: 3353 }] };
type Call = { name: string; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void };
const settle = () => new Promise(resolve => setImmediate(resolve));
async function harness(canEdit = true, storage = new Map<string, string>(), canCreateMenu = false, canDeleteMenu = false) {
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
    "@/lib/inventory/recipe-actions": Object.fromEntries(["getRecipeAction", "listRecipeOptionsAction", "saveRecipeAction", "createMenuAction", "deleteMenuAction"].map(name => [name, action(name)])),
    "@/lib/inventory/recipe-form": recovery, "../inventory/presentation": presentation,
  }, { navigator, crypto: { randomUUID }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { addEventListener() {}, removeEventListener() {} } });
  const render = () => { cursor = 0; return loaded.RecipeWorkspace({ actorId, canEdit, canCreateMenu, canDeleteMenu, initial } as never); };
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
    assert.equal(elements(tree).find(e => e.type === "Workspace")!.props.canCreateMenu, role === "ADMIN");
    assert.equal(elements(tree).find(e => e.type === "Workspace")!.props.canDeleteMenu, role === "ADMIN");
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

function fillMenu(h: Awaited<ReturnType<typeof harness>>) {
  h.click("Tambah Menu"); h.change("Nama menu", "New latte"); h.change("Kategori", initial.categories[0].id);
  h.change("Harga jual", "24000"); h.change("Bahan 1", ingredientId); h.change("Jumlah 1", "100");
}
test("only ADMIN sees menu creation; duplicate clicks create once and select the server product", async () => {
  for (const canEdit of [true, false]) assert.doesNotMatch(text((await harness(canEdit)).render()), /Tambah Menu/);
  const h = await harness(true, new Map(), true); fillMenu(h);
  assert.doesNotMatch(text(h.render()), /Inactive unused/);
  const submit = h.submitHandler(), pending = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, "createMenuAction");
  const request = h.calls[0].input as recovery.MenuSubmission;
  assert.equal(request.price, 24000); assert.equal(request.name, "New latte");
  assert.deepEqual(request.items, [{ ingredientId, quantity: "100", unit: "ml" }]);
  assert.deepEqual(JSON.parse(h.storage.get(recovery.recipeRecoveryKey(actorId))!), request);
  assert.equal(h.button("Batal tambah menu").props.disabled, true);
  const createdId = randomUUID(); h.calls[0].resolve({ success: true, created: { productId: createdId } }); await settle();
  assert.equal(h.calls[1].input, createdId);
  h.calls[1].resolve({ success: true, recipe: { ...detail, productId: createdId, productName: "New latte", productActive: true, productAvailable: true } });
  h.calls[2].resolve({ ...initial, products: [...initial.products, { ...initial.products[0], id: createdId, name: "New latte", active: true, available: true }] });
  await pending;
  assert.equal(h.storage.size, 0); assert.match(text(h.render()), /Menu dan resep tersimpan.*New latte/);
  assert.ok(h.button("Simpan resep"));
});
test("menu recovery survives lost responses, failed retries and reload without replacement or automatic writes", async () => {
  const h = await harness(true, new Map(), true); fillMenu(h); const pending = h.submit();
  h.calls[0].reject(new Error("lost response")); await pending;
  const request = h.calls[0].input;
  h.change("Nama menu", "Replacement"); h.change("Jumlah 1", "999"); h.click("Batal tambah menu");
  h.click("Periksa / coba lagi"); assert.deepEqual(h.calls[1].input, request);
  h.calls[1].resolve({ success: false, code: "FORBIDDEN" }); await settle(); assert.equal(h.storage.size, 1);
  h.unmount(); const restored = await harness(true, h.storage, true);
  assert.equal(restored.calls.length, 0); restored.click("Periksa / coba lagi"); assert.deepEqual(restored.calls[0].input, request);
  restored.calls[0].resolve({ success: true, created: { productId, replayed: true } }); await settle();
  restored.calls[1].reject(new Error("read unavailable")); restored.calls[2].resolve(initial); await settle();
  assert.equal(h.storage.size, 0); assert.match(text(restored.render()), /Menu dan resep tersimpan, tetapi data terbaru belum dapat dimuat/);
  assert.equal(elements(restored.render()).filter(e => e.type === "form").length, 0);
});
test("menu validation, connectivity and recovery storage guard writes; first rejection allows correction", async () => {
  const h = await harness(true, new Map(), true); fillMenu(h);
  for (const price of ["0", "-1", "24000.5", "1e3", "2147483648"]) { h.change("Harga jual", price); await h.submit(); }
  assert.equal(h.calls.length, 0); h.change("Harga jual", "24000");
  h.navigator.onLine = false; await h.submit(); assert.equal(h.calls.length, 0); h.navigator.onLine = true;
  const pending = h.submit(); h.calls[0].resolve({ success: false, code: "INGREDIENT_INACTIVE" }); await pending;
  assert.equal(h.storage.size, 0); assert.equal(elements(h.render()).find(e => e.type === "fieldset")!.props.disabled, false);
  h.storage.set = () => { throw new Error("unavailable"); }; await h.submit(); assert.equal(h.calls.length, 1);
  assert.match(text(h.render()), /Penyimpanan pemulihan tidak tersedia/);
});
test("pending creation cannot be retried after losing ADMIN access and legacy recovery still blocks creation", async () => {
  const menu = { idempotencyKey: randomUUID(), categoryId: initial.categories[0].id, name: "New", price: 22000, items: [{ ingredientId, quantity: "100", unit: "ml" }] };
  const h = await harness(true, new Map([[recovery.recipeRecoveryKey(actorId), JSON.stringify(menu)]]));
  assert.doesNotMatch(text(h.render()), /Tambah Menu|Periksa \/ coba lagi/); assert.equal(h.calls.length, 0);
  const legacy = { idempotencyKey: randomUUID(), productId, expectedRevision: 1, items: menu.items };
  const restored = await harness(true, new Map([[recovery.recipeRecoveryKey(actorId), JSON.stringify(legacy)]]), true);
  assert.equal(restored.button("Tambah Menu").props.disabled, true);
  restored.click("Tambah Menu"); restored.click("Periksa / coba lagi");
  assert.equal(restored.calls[0].name, "saveRecipeAction"); assert.deepEqual(restored.calls[0].input, legacy);
});

test("only ADMIN can open deletion for the selected product; cancel and Escape do not write", async () => {
  for (const canEdit of [true, false]) {
    const h = await harness(canEdit); await select(h);
    assert.doesNotMatch(text(h.render()), /Hapus Menu/);
  }
  const h = await harness(true, new Map(), true, true);
  assert.equal(h.button("Hapus Menu").props.disabled, true);
  h.click("Hapus Menu"); assert.equal(elements(h.render()).filter(e => e.type === "dialog").length, 0);
  await select(h); h.click("Hapus Menu");
  const dialog = elements(h.render()).find(e => e.type === "dialog")!;
  assert.match(text(dialog), /Hapus menu Oat latte.*riwayat transaksi/);
  assert.equal(h.button("Tambah Menu").props.disabled, true);
  h.change("Jumlah 1", "999"); await h.submit(); assert.equal(h.calls.length, 1);
  let prevented = false;
  (dialog.props.onCancel as (event: unknown) => void)({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(elements(h.render()).filter(e => e.type === "dialog").length, 0);
  h.click("Hapus Menu"); h.click("Batal hapus menu"); assert.equal(h.calls.length, 1);
});

test("delete double clicks send once; both results close the modal, clear detail and refresh options", async () => {
  for (const outcome of ["DELETED", "ARCHIVED"]) {
    const h = await harness(true, new Map(), true, true); await select(h); h.click("Hapus Menu");
    const confirm = h.button("Konfirmasi hapus menu").props.onClick as () => void;
    confirm(); confirm();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].name, "deleteMenuAction");
    const request = h.calls[1].input as recovery.MenuDeleteSubmission;
    assert.deepEqual(Object.keys(request).sort(), ["idempotencyKey", "productId"]);
    assert.equal(request.productId, productId);
    assert.deepEqual(JSON.parse(h.storage.get(recovery.menuDeleteRecoveryKey(actorId))!), request);
    assert.equal(h.button("Batal hapus menu").props.disabled, true);
    assert.equal(h.button("Periksa penghapusan / coba lagi").props.disabled, true);
    h.click("Batal hapus menu");
    const dialog = elements(h.render()).find(e => e.type === "dialog")!;
    (dialog.props.onCancel as (event: unknown) => void)({ preventDefault() {} });
    assert.ok(elements(h.render()).find(e => e.type === "dialog"));
    h.calls[1].resolve({ success: true, deleted: { productId, outcome } }); await settle();
    assert.equal(h.calls[2].name, "listRecipeOptionsAction");
    assert.equal(elements(h.render()).filter(e => e.type === "dialog" || e.type === "form").length, 0);
    h.calls[2].resolve({ ...initial, products: outcome === "DELETED" ? [] : initial.products }); await settle();
    assert.match(text(h.render()), outcome === "DELETED" ? /Menu berhasil dihapus\./ : /Menu dinonaktifkan karena memiliki riwayat transaksi\./);
    assert.equal(h.storage.size, 0); assert.equal(h.button("Hapus Menu").props.disabled, true);
    const productSelect = elements(h.render()).find(e => e.type === "select")!;
    assert.equal(productSelect.props.value, "");
    if (outcome === "DELETED") assert.doesNotMatch(text(productSelect), /Oat latte/);
  }
});

test("delete recovery retains exact payload across lost responses, failed retries and reload", async () => {
  const h = await harness(true, new Map(), true, true); await select(h); h.click("Hapus Menu"); h.click("Konfirmasi hapus menu");
  h.calls[1].reject(new Error("lost secret")); await settle();
  assert.match(text(h.render()), /Status penghapusan belum pasti/); assert.doesNotMatch(text(h.render()), /lost secret/);
  const request = h.calls[1].input;
  h.click("Batal hapus menu"); h.change("Produk POS", randomUUID()); h.click("Tambah Menu");
  h.click("Periksa penghapusan / coba lagi"); assert.deepEqual(h.calls[2].input, request);
  h.calls[2].resolve({ success: false, code: "PRODUCT_NOT_FOUND" }); await settle(); assert.equal(h.storage.size, 1);
  h.unmount();
  const restored = await harness(true, h.storage, true, true);
  assert.equal(restored.calls.length, 0); assert.ok(elements(restored.render()).find(e => e.type === "dialog"));
  restored.click("Periksa penghapusan / coba lagi"); assert.deepEqual(restored.calls[0].input, request);
  restored.calls[0].resolve({ success: true, deleted: { productId, outcome: "DELETED", replayed: true } }); await settle();
  restored.calls[1].reject(new Error("refresh failed")); await settle();
  assert.equal(h.storage.size, 0); assert.match(text(restored.render()), /Menu berhasil dihapus.*Daftar produk belum dapat dimuat/);
  assert.equal(elements(restored.render()).filter(e => e.type === "dialog" || e.type === "form").length, 0);
  assert.equal(restored.button("Tambah Menu").props.disabled, true);
  restored.click("Muat ulang resep & WAC"); restored.calls[2].resolve(initial); await settle();
  assert.equal(restored.button("Tambah Menu").props.disabled, false);
});

test("deletion is blocked offline, on storage failure and during recipe/create recovery", async () => {
  const h = await harness(true, new Map(), true, true); await select(h); h.click("Hapus Menu");
  h.navigator.onLine = false; h.click("Konfirmasi hapus menu"); assert.equal(h.calls.length, 1);
  h.navigator.onLine = true;
  h.storage.set = () => { throw new Error("storage unavailable"); };
  h.click("Konfirmasi hapus menu"); assert.equal(h.calls.length, 1); assert.match(text(h.render()), /Menu belum dihapus/);
  const recipe = { productId, expectedRevision: 1, idempotencyKey: randomUUID(), items: [{ ingredientId, quantity: "1", unit: "ml" }] };
  for (const request of [recipe, { idempotencyKey: randomUUID(), name: "New", categoryId: initial.categories[0].id, price: 22000, items: recipe.items }]) {
    const pending = await harness(true, new Map([[recovery.recipeRecoveryKey(actorId), JSON.stringify(request)]]), true, true);
    assert.equal(pending.calls.length, 0);
    if ("productId" in request) assert.equal(pending.button("Hapus Menu").props.disabled, true);
    else assert.doesNotMatch(text(pending.render()), /Hapus Menu/);
  }
});

test("delete rejection is shown in the modal; recovery cannot execute after losing ADMIN access", async () => {
  const h = await harness(true, new Map(), true, true); await select(h); h.click("Hapus Menu"); h.click("Konfirmasi hapus menu");
  h.calls[1].resolve({ success: false, code: "PRODUCT_NOT_FOUND" }); await settle();
  assert.equal(h.storage.size, 0); assert.match(text(elements(h.render()).find(e => e.type === "dialog")), /Menu tidak ditemukan/);
  h.click("Batal hapus menu");
  const request = { productId, idempotencyKey: randomUUID() };
  for (const canEdit of [true, false]) {
    const denied = await harness(canEdit, new Map([[recovery.menuDeleteRecoveryKey(actorId), JSON.stringify(request)]]));
    assert.doesNotMatch(text(denied.render()), /Hapus Menu|Konfirmasi hapus|Periksa penghapusan/);
    assert.equal(denied.calls.length, 0);
  }
  const damaged = await harness(true, new Map([[recovery.menuDeleteRecoveryKey(actorId), "invalid"]]), true, true);
  assert.equal(damaged.button("Hapus Menu").props.disabled, true); assert.equal(damaged.calls.length, 0);
});
