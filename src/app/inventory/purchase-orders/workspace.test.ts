/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as presentation from "./presentation";
import * as input from "./form-input";

const require = createRequire(import.meta.url);
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : ["string", "number"].includes(typeof node) ? String(node) : "";
const flush = () => new Promise(resolve => setImmediate(resolve));
const actorId = randomUUID(), poId = randomUUID(), lineId = randomUUID(), supplierId = randomUUID(), ingredientId = randomUUID();
const detail: any = { id: poId, revision: 1, status: "DRAFT", createdBy: actorId, referenceNumber: "IPO-FIXTURE", supplierId, supplierNameSnapshot: "Supplier fixture", estimatedTotal: 33333, createdAt: "2026-10-12T00:00:00Z", notes: null, lines: [{ id: lineId, ingredientId, itemNameSnapshot: "Susu", proposedName: null, purchaseQuantity: "1", purchaseUnit: "L", baseUnit: "ml", baseQuantity: "1000", estimatedUnitPrice: 33333, estimatedTotal: 33333 }] };
const receipts: any = { id: poId, revision: 1, status: "DRAFT", actualReceivedTotal: null, receipts: [], hasMore: false, lines: [{ lineId, baseUnit: "ml", orderedBaseQuantity: "1000", receivedBaseQuantity: "0", remainingBaseQuantity: "1000", resolvedIngredientId: ingredientId, actualReceivedTotal: null }] };
const ok = (data: any) => ({ success: true, data });
const masters = { suppliers: [{ id: supplierId, name: "Supplier fixture", active: true }], ingredients: [{ id: ingredientId, name: "Susu", baseUnit: "ml", currentStock: "1000", active: true }] };
function harness(role = "STOCK_MANAGEMENT", overrides: any = {}, storage = new Map<string, string>()) {
  const slots: any[] = [], effects: (() => void)[] = []; let index = 0;
  const react = {
    useState(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(work: () => any, deps: any[]) { const i = index++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = work(); }); } },
  };
  const actions = { inventoryPurchaseOrderListAction: async () => ok({ rows: [detail], hasMore: false }), inventoryPurchaseOrderDetailAction: async () => ok(detail), inventoryPurchaseOrderHistoryAction: async () => ok({ rows: [], hasMore: false }), inventoryPurchaseOrderReceiptsAction: async () => ok(receipts), ...overrides };
  const navigator = { onLine: true };
  const mocks: Record<string, any> = { react, "react/jsx-runtime": require("react/jsx-runtime"), "./presentation": presentation, "./form-input": input, "@/lib/inventory-purchase-orders/actions": actions, "@/lib/inventory/actions": { listIngredientsAction: async () => ({ success: true, ingredients: masters.ingredients }), listSuppliersAction: async () => ({ success: true, suppliers: masters.suppliers }) } };
  function load(file: string) {
    const exports: any = {};
    const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    runInNewContext(code, { exports, navigator, crypto: { randomUUID }, sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) }, FormData: class { constructor(private form: any) {} get(name: string) { return this.form.data[name] ?? null; } }, require: (name: string) => { if (name in mocks) return mocks[name]; throw new Error(name); } });
    return exports;
  }
  mocks["./forms"] = load("./forms.tsx");
  const workspace = load("./workspace.tsx");
  const render = () => { index = 0; const tree = workspace.PurchaseOrderWorkspace({ role, actorId, approvals: role === "FINANCE" }); effects.splice(0).forEach(work => work()); return tree; };
  return { render, storage, navigator, button: (label: string) => elements(render()).find(e => e.type === "button" && text(e) === label),
    component: (name: string) => elements(render()).find(e => e.type?.name === name),
    form: (name: string, props?: any) => { const component = props ? { type: mocks["./forms"][name] ?? workspace[name], props } : elements(render()).find(e => e.type?.name === name); index = name === "DraftForm" ? 100 : 150; return component?.type(component.props); },
  };
}
const createIntent = (): presentation.Intent => ({ kind: "write", payload: { id: randomUUID(), key: randomUUID(), revision: 0, operation: "CREATE", data: { supplierId, lines: [{ id: randomUUID(), ingredientId, purchaseQuantity: "1", purchaseUnit: "L", estimatedUnitPrice: 33333 }] } } });

test("exact money handles fractional variance, negative values, zero, unknown and values beyond Number precision", () => {
  assert.equal(presentation.money("33333000", true), "Rp33,333");
  assert.equal(presentation.money("667000", true), "Rp0,667");
  assert.equal(presentation.money("-667000", true), "−Rp0,667");
  assert.equal(presentation.money("9007199254740993"), "Rp9.007.199.254.740.993");
  assert.equal(presentation.money(null), "Belum diketahui"); assert.equal(presentation.money(0), "Rp0");
});
test("Finance defaults to pending; stale reads cannot overwrite later filter; read failures have retry", async () => {
  const requests: any[] = [];
  const h = harness("FINANCE", { inventoryPurchaseOrderListAction: (input: any) => new Promise(resolve => requests.push({ input, resolve })) });
  assert.match(text(h.render()), /Memuat PO/); assert.equal(requests[0].input.status, "WAITING_APPROVAL");
  h.button("Semua PO").props.onClick(); h.render(); assert.equal(requests[1].input.status, undefined);
  requests[1].resolve(ok({ rows: [], hasMore: false })); await flush();
  requests[0].resolve({ success: false, error: "old" }); await flush();
  assert.match(text(h.render()), /Belum ada PO/); assert.doesNotMatch(text(h.render()), /old/);
  h.button("Muat ulang").props.onClick(); h.render(); requests[2].resolve({ success: false, error: "Koneksi gagal" }); await flush();
  assert.match(text(h.render()), /Koneksi gagal/); assert.ok(h.button("Coba lagi"));
});
test("ADMIN has no creation, edit, decision or receiving controls; self-approval is hidden", async () => {
  for (const status of ["DRAFT", "WAITING_APPROVAL", "APPROVED", "ORDERED", "PARTIALLY_RECEIVED"]) {
    const row = { ...detail, status };
    const h = harness("ADMIN", { inventoryPurchaseOrderDetailAction: async () => ok(row) }); h.render(); await flush(); h.button("Detail PO").props.onClick(); h.render(); await flush();
    assert.equal(h.button("PO baru"), undefined); assert.equal(h.button("Ubah draf"), undefined); assert.equal(h.component("ReceiveForm"), undefined); assert.equal(h.form("DecisionForm"), null);
  }
  assert.deepEqual(presentation.allowedOperations("FINANCE", actorId, { ...detail, status: "WAITING_APPROVAL" }), []);
  assert.deepEqual(presentation.allowedOperations("FINANCE", "another", { ...detail, status: "WAITING_APPROVAL" }), ["APPROVE", "REJECT"]);
});
test("duplicate/offline protection and exact retry survive reload and later rejection", async () => {
  const requests: any[] = [], storage = new Map<string, string>();
  const actions = { inventoryPurchaseOrderWriteAction: (input: any) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) };
  const h = harness("STOCK_MANAGEMENT", actions, storage); h.render(); await flush(); h.button("PO baru").props.onClick();
  const submit = h.component("DraftForm").props.submit, request = createIntent();
  h.navigator.onLine = false; await submit(request); assert.equal(requests.length, 0);
  h.navigator.onLine = true; void submit(request); void submit(request); assert.equal(requests.length, 1);
  requests[0].reject(new Error("lost response")); await flush(); assert.equal(storage.size, 1);
  const recovered = harness("STOCK_MANAGEMENT", actions, storage); recovered.render(); await flush();
  assert.equal(recovered.button("PO baru").props.disabled, true);
  recovered.button("Ulangi permintaan yang sama").props.onClick(); assert.equal(JSON.stringify(requests[1].input), JSON.stringify(request.payload));
  requests[1].resolve({ success: false, retryable: false, code: "FORBIDDEN", error: "Denied" }); await flush(); assert.equal(storage.size, 1);
  recovered.button("Ulangi permintaan yang sama").props.onClick(); requests[2].resolve(ok({ id: poId })); await flush(); recovered.render(); await flush(); assert.equal(storage.size, 0);
});
test("stale revision on first attempt refreshes and closes stale editor; broken storage blocks writes", async () => {
  const h = harness("STOCK_MANAGEMENT", { inventoryPurchaseOrderWriteAction: async () => ({ success: false, retryable: false, code: "STALE_REVISION" }) }); h.render(); await flush(); h.button("PO baru").props.onClick();
  await h.component("DraftForm").props.submit(createIntent()); assert.equal(h.storage.size, 0); assert.equal(h.component("DraftForm"), undefined); assert.match(text(h.render()), /PO telah berubah/);
  const broken = new Map([[`inventory-po-pending:${actorId}`, "invalid json"]]); const b = harness("STOCK_MANAGEMENT", {}, broken); b.render(); await flush(); assert.equal(b.button("PO baru").props.disabled, true);
});

test("definite validation rejection preserves the mounted draft and permits corrected intent", async () => {
  const requests: any[] = [];
  const h = harness("STOCK_MANAGEMENT", { inventoryPurchaseOrderWriteAction: async (value: any) => {
    requests.push(value);
    return requests.length === 1 ? { success: false, retryable: false, code: "DUPLICATE_INGREDIENT", error: "Duplicate" } : ok({ id: poId });
  } });
  h.render(); await flush(); h.button("PO baru").props.onClick();
  let form = h.form("DraftForm");
  elements(form).find(e => e.type === "button" && text(e) === "Tambah bahan").props.onClick(); form = h.form("DraftForm");
  elements(form).find(e => e.type === "input" && e.props.maxLength === 128).props.onChange({ target: { value: "Nama yang perlu dikoreksi" } });
  const request = createIntent(); await h.component("DraftForm").props.submit(request);
  assert.equal(h.storage.size, 0); assert.ok(h.component("DraftForm")); assert.equal(h.component("DraftForm").props.locked, false);
  assert.equal(elements(h.form("DraftForm")).find(e => e.type === "input" && e.props.maxLength === 128).props.value, "Nama yang perlu dikoreksi");
  const corrected = { ...request, payload: { ...request.payload, key: randomUUID() } };
  await h.component("DraftForm").props.submit(corrected); assert.equal(requests.length, 2); assert.notEqual(requests[0].key, requests[1].key);
});

test("receiving validation rejection preserves selection; the same rejection after uncertainty remains locked", async () => {
  const requests: any[] = [], row = { ...detail, status: "ORDERED" };
  const h = harness("STOCK_MANAGEMENT", {
    inventoryPurchaseOrderDetailAction: async () => ok(row),
    inventoryPurchaseOrderReceiveAction: (value: any) => new Promise((resolve, reject) => requests.push({ value, resolve, reject })),
  });
  h.render(); await flush(); h.button("Detail PO").props.onClick(); h.render(); await flush();
  let form = h.form("ReceiveForm"); elements(form).find(e => e.props.type === "checkbox").props.onChange({ target: { checked: true } });
  const request: presentation.Intent = { kind: "receive", payload: { id: poId, key: randomUUID(), revision: 1, receivedAt: "2026-10-12T10:00:00+07:00", lines: [{ lineId, quantity: "1", unit: "L", purchaseUnitCost: 33333, varianceReason: "" }] } };
  void h.component("ReceiveForm").props.submit(request);
  requests[0].resolve({ success: false, retryable: false, code: "INVALID_INPUT", error: "Periksa isian" }); await flush();
  assert.equal(h.storage.size, 0); assert.equal(h.component("ReceiveForm").props.locked, false);
  form = h.form("ReceiveForm"); assert.equal(elements(form).find(e => e.props.type === "checkbox").props.checked, true);
  const next = { ...request, payload: { ...request.payload, key: randomUUID() } };
  void h.component("ReceiveForm").props.submit(next); requests[1].reject(new Error("lost response")); await flush();
  h.button("Ulangi permintaan yang sama").props.onClick();
  requests[2].resolve({ success: false, retryable: false, code: "INVALID_INPUT", error: "Periksa isian" }); await flush();
  assert.equal(h.storage.size, 1); assert.equal(h.component("ReceiveForm").props.locked, true);
  assert.equal(JSON.stringify(requests[1].value), JSON.stringify(requests[2].value));
});
test("receiving validates price increase on equivalent units before sending and renders exact receipt evidence", async () => {
  const calls: any[] = [], row = { ...detail, status: "ORDERED" };
  const h = harness("STOCK_MANAGEMENT", { inventoryPurchaseOrderDetailAction: async () => ok(row), inventoryPurchaseOrderReceiveAction: async (input: any) => { calls.push(input); return ok({ id: poId }); } });
  h.render(); await flush(); h.button("Detail PO").props.onClick(); h.render(); await flush();
  const submit = h.component("ReceiveForm").props.submit;
  const request: presentation.Intent = { kind: "receive", payload: { id: poId, key: randomUUID(), revision: 1, receivedAt: "2026-10-12T10:00:00+07:00", lines: [{ lineId, quantity: "1", unit: "ml", purchaseUnitCost: 34, varianceReason: "" }] } };
  await submit(request); assert.equal(calls.length, 0); assert.match(text(h.render()), /Harga aktual naik/);
  (request.payload.lines as any[])[0].varianceReason = "Harga supplier naik"; await submit(request); assert.equal(calls.length, 1);
  const f = harness("FINANCE", { inventoryPurchaseOrderReceiptsAction: async () => ok({ ...receipts, actualReceivedTotal: "34", receipts: [{ id: "r", referenceNumber: "SIN-fixture", supplierName: "Supplier fixture", receivedAt: "2026-10-12T03:00:00Z", postedAt: "2026-10-12T03:01:00Z", actorId, items: [{ id: "i", ingredientName: "Susu", quantity: "1", unit: "ml", approvedUnitPrice: 33333, approvedPurchaseUnit: "L", purchaseUnitCost: 34, actualAmount: 34, approvedEstimatedAmountMicros: "33333000", priceVarianceMicros: "667000", varianceReason: "Harga supplier naik" }] }] }) });
  f.render(); await flush(); f.button("Detail PO").props.onClick(); f.render(); await flush(); assert.match(text(f.render()), /Rp33,333[\s\S]*Rp34[\s\S]*Rp0,667[\s\S]*Harga supplier naik/);
});
test("draft form creates multiple stable lines and preserves IDs while editing; receive form requires explicit proposal resolution", () => {
  const h = harness(); const sent: any[] = [];
  const props = { detail: null, locked: false, masters, submit: async (v: any) => { sent.push(v); }, cancel() {} };
  let form = h.form("DraftForm", props);
  for (let i = 0; i < 2; i++) { elements(form).find(e => e.type === "button" && text(e) === "Tambah bahan").props.onClick(); form = h.form("DraftForm", props); }
  const fieldsets = elements(form).filter(e => e.type === "fieldset" && elements(e).some(n => n.type === "legend" && /^Bahan /.test(text(n))));
  assert.ok(fieldsets.length >= 2);
  const quantityInputs = elements(form).filter(e => e.type === "input" && e.props.inputMode === "decimal"); assert.equal(quantityInputs.length, 2);
  form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { supplier: supplierId } } });
  assert.equal(sent[0].payload.data.lines.length, 2); assert.notEqual(sent[0].payload.data.lines[0].id, sent[0].payload.data.lines[1].id);
  assert.equal(sent[0].payload.data.estimatedTotal, undefined);
  const r = harness(); const proposed = { ...detail, lines: [{ ...detail.lines[0], ingredientId: null, proposedName: "Susu baru" }] };
  const receiveProps = { detail: proposed, receipts: { ...receipts, lines: [{ ...receipts.lines[0], resolvedIngredientId: null }] }, locked: false, masters, submit: async () => {} };
  let receive = r.form("ReceiveForm", receiveProps); elements(receive).find(e => e.props.type === "checkbox").props.onChange({ target: { checked: true } }); receive = r.form("ReceiveForm", receiveProps);
  const resolution = elements(receive).find(e => e.type === "select" && e.props.required); assert.equal(resolution.props.value, ""); assert.match(text(resolution), /Buat bahan baru.*Gunakan:\s+Susu/);
});
test("both routes enforce existing server guards and navigation is connected", () => {
  assert.match(readFileSync(new URL("./page.tsx", import.meta.url), "utf8"), /await requireInventoryManager\(\)/);
  assert.match(readFileSync(new URL("../../finance/purchase-orders/page.tsx", import.meta.url), "utf8"), /await requireFinanceManager\(\)/);
  assert.match(readFileSync(new URL("../page.tsx", import.meta.url), "utf8"), /href="\/inventory\/purchase-orders"/);
  assert.match(readFileSync(new URL("../../finance-navigation.tsx", import.meta.url), "utf8"), /href="\/finance\/purchase-orders"/);
});

test("draft edits retain multi-line identities and only submit commercial inputs", () => {
  const h = harness(), sent: any[] = [];
  const row = { ...detail, lines: [...detail.lines, { ...detail.lines[0], id: randomUUID(), ingredientId: null, proposedName: "Usulan baru" }] };
  const form = h.form("DraftForm", { detail: row, locked: false, masters, submit: async (v: any) => { sent.push(v); }, cancel() {} });
  form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { supplier: supplierId, notes: "Catatan" } } });
  const request = sent[0]; input.validateIntent(request);
  const draft = request.payload.data as any;
  assert.equal(request.payload.operation, "EDIT"); assert.equal(request.payload.revision, 1);
  assert.deepEqual(draft.lines.map((l: any) => l.id), row.lines.map((l: any) => l.id));
  assert.equal(draft.lines[1].proposedIngredient.name, "Usulan baru");
  assert.equal(draft.lines[0].estimatedTotal, undefined);
});
test("status controls submit exact revisions for submission, ordering and Finance decisions", () => {
  for (const [role, status, expected] of [["STOCK_MANAGEMENT", "DRAFT", "SUBMIT"], ["STOCK_MANAGEMENT", "APPROVED", "ORDER"], ["FINANCE", "WAITING_APPROVAL", "APPROVE"]]) {
    const h = harness(role), sent: any[] = [];
    const props = { role, actorId: "another", detail: { ...detail, status }, locked: false, submit: async (v: any) => { sent.push(v); } };
    let form = h.form("DecisionForm", props);
    form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { note: "Catatan" } } });
    assert.equal(sent[0].payload.operation, expected); assert.equal(sent[0].payload.revision, 1); input.validateIntent(sent[0]);
    if (role === "FINANCE") {
      elements(form).find(e => e.type === "select").props.onChange({ target: { value: "REJECT" } }); form = h.form("DecisionForm", props);
      assert.equal(elements(form).find(e => e.props.name === "note").props.required, true);
      form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { note: "   " } } }); assert.throws(() => input.validateIntent(sent[1]));
      form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { note: "Tidak dibutuhkan" } } }); input.validateIntent(sent[2]); assert.equal(sent[2].payload.operation, "REJECT");
    }
  }
});
test("receiving sends only selected lines with explicit actual price, WIB timestamp and proposal decision", () => {
  const h = harness(), sent: any[] = [], secondId = randomUUID();
  const row = { ...detail, lines: [{ ...detail.lines[0], ingredientId: null, proposedName: "Susu baru" }, { ...detail.lines[0], id: secondId }] };
  const props = { detail: row, receipts: { ...receipts, lines: [{ ...receipts.lines[0], resolvedIngredientId: null }, { ...receipts.lines[0], lineId: secondId }] }, masters, locked: false, submit: async (v: any) => { sent.push(v); } };
  let form = h.form("ReceiveForm", props);
  elements(form).find(e => e.props.type === "checkbox").props.onChange({ target: { checked: true } }); form = h.form("ReceiveForm", props);
  elements(form).find(e => e.type === "input" && e.props.inputMode === "numeric").props.onChange({ target: { value: "34000" } }); form = h.form("ReceiveForm", props);
  elements(form).find(e => e.type === "select" && e.props.required).props.onChange({ target: { value: "CREATE" } }); form = h.form("ReceiveForm", props);
  assert.equal(elements(form).find(e => e.props.name === `reason:${lineId}`).props.required, true);
  form.props.onSubmit({ preventDefault() {}, currentTarget: { data: { receivedAt: "2026-10-12T10:30", [`quantity:${lineId}`]: "0.5", [`reason:${lineId}`]: "Harga naik" } } });
  input.validateIntent(sent[0]); const lines = sent[0].payload.lines as any[]; assert.equal(lines.length, 1); assert.equal(lines[0].quantity, "0.5"); assert.equal(lines[0].resolution.type, "CREATE"); assert.equal(sent[0].payload.receivedAt, "2026-10-12T10:30:00+07:00");
});
test("inconsistent detail/receiving revisions block mutation until a consistent refresh", async () => {
  const h = harness("STOCK_MANAGEMENT", { inventoryPurchaseOrderReceiptsAction: async () => ok({ ...receipts, revision: 2 }) }); h.render(); await flush(); h.button("Detail PO").props.onClick(); h.render(); await flush();
  assert.match(text(h.render()), /PO berubah saat dibaca/); assert.equal(h.button("PO baru").props.disabled, true); assert.equal(h.component("ReceiveForm"), undefined);
});
test("browser input checks reject unknown prices, fractional totals and excess precision without rounding", () => {
  for (const patch of [{ estimatedUnitPrice: null }, { estimatedUnitPrice: -1 }, { estimatedUnitPrice: 2147483648 }, { purchaseQuantity: "0" }, { purchaseQuantity: "0.0001" }, { purchaseQuantity: "0.5", estimatedUnitPrice: 1 }]) {
    const request = createIntent(); const data = request.payload.data as any; Object.assign(data.lines[0], patch); assert.throws(() => input.validateIntent(request));
  }
  assert.equal(input.priceIncreased("34", "ml", detail.lines[0]), true);
  assert.equal(input.priceIncreased("33", "ml", detail.lines[0]), false);
  assert.equal(input.priceIncreased("33333", "L", detail.lines[0]), false);
  const request: presentation.Intent = { kind: "receive", payload: { id: poId, key: randomUUID(), revision: 1, lines: [{ lineId, unit: "ml", purchaseUnitCost: 34, varianceReason: "   " }] } };
  assert.throws(() => input.validateVariance(request, detail), (e: any) => e.code === "VARIANCE_REASON_REQUIRED");
});
