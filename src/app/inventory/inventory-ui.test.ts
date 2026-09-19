import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as presentation from "./presentation";
import * as receiving from "../../lib/inventory/receiving-form";

const require = createRequire(import.meta.url);
type Element = { type: unknown; key?: string | null; props: Record<string, unknown> };
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
const supplier = { id: randomUUID(), name: "Greenfields", contact: "Lia", phone: "123", address: "Jakarta", active: true, createdAt: "2026-09-18T01:00:00Z", updatedAt: "2026-09-18T01:00:00Z" };
const oat = { id: randomUUID(), name: "Oatmilk", baseUnit: "ml", currentStock: "12000", minimumStock: "1000", active: true, stockStatus: "AVAILABLE" };
const ingredientResult = { success: true, ingredients: [oat, { ...oat, id: randomUUID(), name: "Beans", baseUnit: "g", currentStock: "0", stockStatus: "EMPTY" },
  { ...oat, id: randomUUID(), name: "Cups", baseUnit: "pcs", currentStock: "0.001", minimumStock: "0.002", stockStatus: "LOW" }] };
const supplierResult = { success: true, suppliers: [supplier, { ...supplier, id: randomUUID(), name: "Inactive", active: false }] };
const saved = { id: randomUUID(), referenceNumber: "SI-receipt", supplierName: "Greenfields", receivedAt: "2026-09-18T01:00:00Z", createdAt: "2026-09-18T02:00:00Z", actorName: "Stock staff", total: 240000, notes: "Morning",
  items: [{ id: randomUUID(), ingredientId: oat.id, ingredientName: "Oatmilk", inputQuantity: "12", inputUnit: "L", baseQuantity: "12000", baseUnit: "ml", unitCost: 20, purchaseUnitCost: null, receivedUnitCostMicros: "20000000", lineTotal: 240000 }] };
const row = { id: saved.id, referenceNumber: saved.referenceNumber, supplierName: "Greenfields", receivedAt: saved.receivedAt, createdAt: saved.createdAt, actorName: "Stock staff", itemCount: 1, total: 240000 };
const history = { success: true, entries: [row], nextCursor: null };
const unavailable = { success: false, code: "UNAVAILABLE", error: "Unavailable" };
const settle = () => new Promise(resolve => setImmediate(resolve));
type Call = { name: string; input: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void };

function harness(file: string, component: string, props: Record<string, unknown>, storage = new Map<string, string>()) {
  const slots: unknown[] = [], effects: (() => unknown)[] = [], cleanups: (() => void)[] = [];
  let cursor = 0;
  const calls: Call[] = [];
  const action = (name: string) => (input?: unknown) => new Promise((resolve, reject) => calls.push({ name, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)), resolve, reject }));
  const navigator = { onLine: true };
  const listeners = new Map<string, (event: unknown) => void>();
  const loaded = load(file, {
    react: {
      useState(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
        return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
      useRef(value: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
      useEffect(effect: () => unknown) { const i = cursor++; if (!(i in slots)) { slots[i] = true; effects.push(effect); } },
    },
    "@/lib/inventory/actions": Object.fromEntries(["createStockInAction", "createSupplierAction", "updateSupplierAction", "listIngredientsAction", "listSuppliersAction", "listStockInsAction", "getStockInAction"].map(name => [name, action(name)])),
    "@/lib/inventory/receiving-form": receiving, "./presentation": presentation,
    "./suppliers-panel": { SuppliersPanel: "SuppliersPanel" }, "./stock-in-form": { StockInForm: "StockInForm" }, "./stock-in-history": { StockInHistory: "StockInHistory" },
  }, { navigator, crypto: { randomUUID }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) } });
  const render = () => { cursor = 0; return loaded[component](props as never); };
  render(); for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); }
  const button = (label: string) => { const found = elements(render()).find(e => e.type === "button" && text(e) === label); assert.ok(found, label); return found; };
  const change = (label: string, value: string) => {
    const found = elements(render()).find(e => e.type === "label" && text(e).startsWith(label)); assert.ok(found, label);
    const input = elements(found).find(e => ["input", "select", "textarea"].includes(String(e.type)))!;
    (input.props.onChange as (event: unknown) => void)({ target: { value } });
  };
  const submitHandler = () => elements(render()).find(e => e.type === "form")!.props.onSubmit as (event: unknown) => Promise<void>;
  return { render, props, change, calls, navigator, listeners, storage, button, submitHandler,
    click: (label: string) => (button(label).props.onClick as () => Promise<void>)(),
    submit: () => submitHandler()({ preventDefault() {} }), unmount: () => cleanups.forEach(fn => fn()) };
}
const receivingProps = () => ({ actorId: "stock-user", ingredients: ingredientResult, suppliers: supplierResult, loading: false, reload: async () => {}, onSaved: () => {}, onHistory: () => {} });
function fillReceipt(h: ReturnType<typeof harness>) {
  h.change("Supplier", supplier.id); h.change("Diterima", "2026-09-18T08:00"); h.change("Bahan", oat.id);
  h.change("Jumlah", "12"); h.change("Satuan", "L"); h.change("Biaya", "20");
}

test("inventory route guards before any data read; stock role gets only inventory and logout", async () => {
  let role = "FINANCE", reads = 0;
  const page = load("./page.tsx", {
    "next/link": { default: "a" }, "next/navigation": { redirect() {} }, "@/lib/auth/actions": { logoutAction() {} },
    "@/lib/auth/authorization": { requireInventoryManager: async () => { if (!["ADMIN", "STOCK_MANAGEMENT"].includes(role)) throw new Error("denied"); return { id: "actor", role, name: "Staff", passwordHash: "secret" }; } },
    "@/lib/inventory/actions": { listIngredientsAction: async () => { reads++; return ingredientResult; }, listSuppliersAction: async () => { reads++; return supplierResult; }, listStockInsAction: async () => { reads++; return history; } },
    "./inventory-workspace": { InventoryWorkspace: "Workspace" },
  });
  for (role of ["FINANCE", "CASHIER", "anonymous"]) { await assert.rejects(async () => page.default(), /denied/); assert.equal(reads, 0); }
  for (role of ["STOCK_MANAGEMENT", "ADMIN"]) {
    const tree = await page.default();
    assert.match(text(tree), /Stock Management.*Staff.*Logout/);
    const links = elements(tree).filter(e => e.props.href).map(e => e.props.href);
    assert.deepEqual(links, role === "ADMIN" ? ["/admin"] : []);
    assert.doesNotMatch(JSON.stringify(tree), /passwordHash|secret/);
  }
});

test("stock overview renders exact server balances/statuses with search, filter and failed reads", async () => {
  const h = harness("./inventory-workspace.tsx", "InventoryWorkspace", { actorId: "stock-user", initialIngredients: ingredientResult, initialSuppliers: supplierResult, initialHistory: history });
  assert.match(text(h.render()), /12.000 ml.*Tersedia.*Beans.*Habis.*Cups.*Stok rendah/);
  h.change("Cari bahan", "oat"); assert.equal(elements(h.render()).filter(e => e.type === "article").length, 1);
  h.change("Cari bahan", ""); h.change("Status", "LOW"); assert.equal(elements(h.render()).filter(e => e.type === "article").length, 1);
  assert.equal(presentation.quantity("999999999999999.999"), "999.999.999.999.999,999");
  const slow = h.click("Muat ulang stok"), newer = h.click("Muat ulang stok");
  h.calls[2].resolve(unavailable); h.calls[3].resolve(supplierResult); await newer;
  h.calls[0].resolve(ingredientResult); h.calls[1].resolve(supplierResult); await slow;
  assert.match(text(h.render()), /Data belum dapat dimuat/); assert.doesNotMatch(text(h.render()), /12.000 ml/);
  const retry = h.click("Muat ulang stok"); h.calls[4].resolve({ success: true, ingredients: [] }); h.calls[5].resolve(supplierResult); await retry;
  assert.match(text(h.render()), /Belum ada bahan/);
});

test("supplier save cannot discard receiving stock refresh or restore stale suppliers; history refreshes too", async () => {
  const workspace = harness("./inventory-workspace.tsx", "InventoryWorkspace", { actorId: "stock-user", initialIngredients: ingredientResult, initialSuppliers: supplierResult, initialHistory: history });
  const panel = (type: string) => elements(workspace.render()).find(e => e.type === type)!;
  const initialHistory = panel("StockInHistory");
  const receiving = harness("./stock-in-form.tsx", "StockInForm", panel("StockInForm").props);
  const suppliers = harness("./suppliers-panel.tsx", "SuppliersPanel", panel("SuppliersPanel").props);

  await workspace.click("Stock In");
  fillReceipt(receiving);
  const receiptWrite = receiving.submit();
  await workspace.click("Supplier");
  await suppliers.click("Edit Greenfields");
  suppliers.change("Status supplier", "false");
  const supplierWrite = suppliers.submit();
  const newReceipt = { ...saved, id: randomUUID(), referenceNumber: "SI-new-receipt" };
  receiving.calls[0].resolve({ success: true, stockIn: newReceipt }); await receiptWrite;
  assert.deepEqual(workspace.calls.map(call => call.name), ["listIngredientsAction", "listSuppliersAction"]);
  const refreshedHistory = panel("StockInHistory");
  assert.notEqual(refreshedHistory.key, initialHistory.key, "Receiving remounts history to fetch committed receipts");
  assert.equal(refreshedHistory.props.initial, undefined);

  suppliers.calls[0].resolve({ success: true, supplier: { ...supplier, active: false } }); await supplierWrite;
  assert.equal(panel("StockInForm").props.loading, true, "Supplier completion must not end the stock refresh");
  assert.equal(panel("StockInHistory").key, refreshedHistory.key);
  workspace.calls[0].resolve({ success: true, ingredients: [{ ...oat, currentStock: "24000" }] });
  workspace.calls[1].resolve(supplierResult); // Older read still says the supplier is active.
  await settle();
  await workspace.click("Stok bahan");
  assert.match(text(workspace.render()), /24.000 ml/);
  assert.doesNotMatch(text(workspace.render()), /12.000 ml/);
  assert.equal(panel("StockInForm").props.loading, false);
  const currentSuppliers = panel("SuppliersPanel").props.result as typeof supplierResult;
  assert.equal(currentSuppliers.suppliers.find(row => row.id === supplier.id)?.active, false);

  const refreshed = harness("./stock-in-history.tsx", "StockInHistory", refreshedHistory.props);
  assert.equal(refreshed.calls[0].name, "listStockInsAction");
  refreshed.calls[0].resolve({ success: true, entries: [{ ...row, id: newReceipt.id, referenceNumber: newReceipt.referenceNumber }, row], nextCursor: null });
  await settle();
  assert.match(text(refreshed.render()), /SI-new-receipt/);
});

test("workspace keeps newer stock and suppliers across tab changes and ignores reads after unmount", async () => {
  const h = harness("./inventory-workspace.tsx", "InventoryWorkspace", { actorId: "stock-user", initialIngredients: ingredientResult, initialSuppliers: supplierResult, initialHistory: history });
  const reload = h.button("Muat ulang stok").props.onClick as () => Promise<void>;
  const older = reload();
  await h.click("Supplier");
  const newer = reload();
  await h.click("Stok bahan");
  h.calls[2].resolve({ success: true, ingredients: [{ ...oat, currentStock: "36000" }] });
  h.calls[3].resolve({ success: true, suppliers: [{ ...supplier, active: false }] }); await newer;
  h.calls[0].resolve(ingredientResult); h.calls[1].resolve(supplierResult); await older;
  assert.match(text(h.render()), /36.000 ml/);
  assert.doesNotMatch(text(h.render()), /12.000 ml/);
  const supplierPanel = () => elements(h.render()).find(e => e.type === "SuppliersPanel")!;
  assert.equal((supplierPanel().props.result as typeof supplierResult).suppliers[0].active, false);
  const pending = reload(); h.unmount();
  h.calls[4].resolve(ingredientResult); h.calls[5].resolve(supplierResult); await pending;
  assert.equal(supplierPanel().props.loading, true, "Unmounted reads cannot update state");
  const form = elements(h.render()).find(e => e.type === "StockInForm")!;
  assert.equal((form.props.ingredients as typeof ingredientResult).ingredients[0].currentStock, "36000");
  assert.equal((supplierPanel().props.result as typeof supplierResult).suppliers[0].active, false);
});

test("Stock In restricts units and inactive options, sends one request and uses server confirmation", async () => {
  let refreshed = 0;
  const h = harness("./stock-in-form.tsx", "StockInForm", { ...receivingProps(), onSaved: () => { refreshed++; } });
  fillReceipt(h);
  assert.doesNotMatch(text(h.render()), /Inactive/);
  const units = elements(elements(h.render()).find(e => e.type === "label" && text(e).startsWith("Satuan"))).filter(e => e.type === "option").map(e => e.props.value);
  assert.deepEqual(units, ["ml", "L"]);
  const handler = h.submitHandler(), event = { preventDefault() {} };
  const pending = handler(event); await handler(event);
  assert.equal(h.calls.length, 1); assert.equal(h.storage.size, 1);
  const request = h.calls[0].input as receiving.ReceivingSubmission;
  assert.equal(request.items[0].quantity, "12"); assert.equal(request.items[0].unitCost, 20); assert.equal(request.receivedAt, "2026-09-18T08:00:00+07:00");
  assert.ok(elements(h.render()).filter(e => e.type === "fieldset").every(e => e.props.disabled));
  h.calls[0].resolve({ success: true, stockIn: saved }); await pending;
  assert.equal(refreshed, 1); assert.equal(h.storage.size, 0); assert.match(text(h.render()), /Penerimaan tersimpan.*Oatmilk\s*: \+ 12.000 ml.*Rp240.000/);
  await handler(event); assert.equal(h.calls.length, 1, "A stale submit handler cannot repeat a completed receipt");
});

test("interrupted Stock In retains immutable intent across retries and page reload; never auto-submits", async () => {
  const storage = new Map<string, string>();
  const h = harness("./stock-in-form.tsx", "StockInForm", receivingProps(), storage); fillReceipt(h);
  const attempt = h.submit(); h.calls[0].reject(new Error("private transport")); await attempt;
  const original = h.calls[0].input;
  assert.match(text(h.render()), /Status penerimaan belum pasti/); assert.doesNotMatch(text(h.render()), /private transport/);
  h.change("Jumlah", "999");
  let retry = h.click("Periksa / coba lagi"); assert.deepEqual(h.calls[1].input, original);
  h.calls[1].resolve({ success: false, code: "FORBIDDEN" }); await retry;
  assert.equal(storage.size, 1); assert.equal(h.button("Simpan penerimaan").props.disabled, true);
  let prevented = false; h.listeners.get("beforeunload")!({ preventDefault() { prevented = true; }, returnValue: "" }); assert.equal(prevented, true);
  h.unmount();
  const restored = harness("./stock-in-form.tsx", "StockInForm", receivingProps(), storage);
  assert.equal(restored.calls.length, 0); assert.match(text(restored.render()), /Status penerimaan belum pasti/);
  retry = restored.click("Periksa / coba lagi"); assert.deepEqual(restored.calls[0].input, original);
  restored.calls[0].resolve({ success: true, stockIn: { ...saved, replayed: true } }); await retry;
  assert.equal(storage.size, 0); assert.match(text(restored.render()), /Penerimaan tersimpan/);
});

test("offline and invalid form inputs do not submit; definite validation rejection can be corrected", async () => {
  const h = harness("./stock-in-form.tsx", "StockInForm", receivingProps()); fillReceipt(h);
  h.navigator.onLine = false; await h.submit(); assert.equal(h.calls.length, 0); assert.equal(h.storage.size, 0);
  assert.match(text(h.render()), /Tidak ada koneksi/);
  h.navigator.onLine = true; h.change("Biaya", "1.5"); await h.submit(); assert.equal(h.calls.length, 0);
  h.change("Biaya", "20"); const pending = h.submit(); h.calls[0].resolve({ success: false, code: "INVALID_COST" }); await pending;
  assert.equal(h.storage.size, 0); assert.equal(h.button("Simpan penerimaan").props.disabled, false);
  assert.match(text(h.render()), /Biaya wajib rupiah bulat/);
});

test("recovery storage failure prevents submission and malformed saved intent never enables a replacement", async () => {
  const storage = new Map<string, string>();
  const h = harness("./stock-in-form.tsx", "StockInForm", receivingProps(), storage); fillReceipt(h);
  storage.set = () => { throw new Error("storage blocked"); };
  await h.submit(); assert.equal(h.calls.length, 0); assert.match(text(h.render()), /Penyimpanan pemulihan tidak tersedia/);
  const damaged = new Map([["aroom.stock-in.pending.stock-user", "not JSON"]]);
  const broken = harness("./stock-in-form.tsx", "StockInForm", receivingProps(), damaged);
  assert.equal(broken.button("Simpan penerimaan").props.disabled, true); assert.equal(broken.calls.length, 0);
  assert.match(text(broken.render()), /Jangan membuat penerimaan pengganti/);
});

test("supplier create/edit/retire and uncertain writes require reload before any further mutation", async () => {
  let changes = 0, reloads = 0;
  const props = { result: supplierResult, loading: false, reload: async () => { reloads++; }, onWriting: () => {}, onSaved: () => { changes++; } };
  const h = harness("./suppliers-panel.tsx", "SuppliersPanel", props);
  await h.click("Edit Greenfields"); h.change("Status supplier", "false"); h.change("Alamat", "New address");
  const handler = h.submitHandler(); const pending = handler({ preventDefault() {} }); await handler({ preventDefault() {} });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, "updateSupplierAction");
  assert.deepEqual(h.calls[0].input, { supplierId: supplier.id, name: "Greenfields", contact: "Lia", phone: "123", address: "New address", active: false });
  h.calls[0].reject(new Error("private transport")); await pending;
  assert.match(text(h.render()), /Status supplier belum pasti/); assert.equal(changes, 0);
  await h.submit(); assert.equal(h.calls.length, 1);
  await h.click("Muat ulang supplier"); assert.equal(reloads, 1);
  h.change("Nama supplier", "New supplier"); const create = h.submit(); assert.equal(h.calls[1].name, "createSupplierAction");
  h.calls[1].resolve({ success: true, supplier }); await create;
  assert.equal(changes, 1); assert.match(text(h.render()), /Supplier disimpan/);
});

test("history paginates, discards stale detail/list responses and preserves saved names/units/amounts", async () => {
  const h = harness("./stock-in-history.tsx", "StockInHistory", { initial: { ...history, nextCursor: row.id, entries: [row, { ...row, id: "second", supplierName: "Other" }] } });
  assert.match(text(h.render()), /18 Sep 2026.*08.00 WIB/);
  let buttons = elements(h.render()).filter(e => e.type === "button" && text(e).includes("Lihat detail"));
  const first = (buttons[0].props.onClick as () => Promise<void>)();
  buttons = elements(h.render()).filter(e => e.type === "button" && text(e).includes("Lihat detail"));
  const second = (buttons[1].props.onClick as () => Promise<void>)();
  h.calls[1].resolve({ success: true, stockIn: { ...saved, supplierName: "Selected snapshot" } }); await second;
  h.calls[0].reject(new Error("old failure")); await first;
  assert.match(text(h.render()), /Selected snapshot.*12 L → 12.000 ml.*Rp20 \/ ml.*Rp240.000/); assert.doesNotMatch(text(h.render()), /old failure/);
  const older = h.click("Lebih lama"); assert.deepEqual(h.calls[2].input, { cursor: row.id });
  const refresh = h.click("Muat ulang riwayat"); h.calls[3].resolve({ success: true, entries: [], nextCursor: null }); await refresh;
  h.calls[2].resolve(history); await older; assert.match(text(h.render()), /Belum ada penerimaan/); assert.doesNotMatch(text(h.render()), /Selected snapshot/);
  const failure = h.click("Muat ulang riwayat"); h.calls[4].reject(new Error("private DB")); await failure;
  assert.match(text(h.render()), /Data belum dapat dimuat/); assert.doesNotMatch(text(h.render()), /private DB/);
});

test("history remount after receiving reloads server history and ignores responses after unmount", async () => {
  const h = harness("./stock-in-history.tsx", "StockInHistory", {});
  assert.equal(h.calls.length, 1); assert.match(text(h.render()), /Memuat riwayat/);
  h.calls[0].resolve(history); await settle(); assert.match(text(h.render()), /Greenfields/);
  const pending = h.click("Muat ulang riwayat"); h.unmount(); h.calls[1].resolve({ success: true, entries: [], nextCursor: null }); await pending;
  assert.match(text(h.render()), /Memuat riwayat/);
});
