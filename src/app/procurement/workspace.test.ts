/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as domain from "../../lib/procurement/domain";

const require = createRequire(import.meta.url);
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : ["string", "number"].includes(typeof node) ? String(node) : "";
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(role: string, actions: any, storage = new Map<string, string>()) {
  const slots: any[] = [], effects: (() => void)[] = []; let index = 0;
  const react = {
    useState(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(work: () => any, deps: any[]) { const i = index++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = work(); }); } },
  };
  const exports: any = {}, navigator = { onLine: true }, confirmations: string[] = [];
  const code = ts.transpileModule(readFileSync(new URL("./workspace.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mocks: Record<string, unknown> = { react, "@/lib/procurement/actions": actions, "@/lib/procurement/domain": domain, "react/jsx-runtime": require("react/jsx-runtime") };
  runInNewContext(code, { exports, navigator, window: { confirm: (message: string) => { confirmations.push(message); return true; } }, crypto: { randomUUID }, sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    FormData: class { constructor(private form: any) {} get(name: string) { return this.form.data[name] ?? null; } [Symbol.iterator]() { return Object.entries(this.form.data)[Symbol.iterator](); } },
    require: (name: string) => { if (name in mocks) return mocks[name]; throw new Error(name); } });
  const render = () => { index = 0; const tree = exports.ProcurementWorkspace({ role, actorId: "actor", approvals: role === "FINANCE" }); effects.splice(0).forEach(work => work()); return tree; };
  return { render, navigator, storage, confirmations,
    transition: () => { const node = elements(render()).find(e => e.type?.name === "TransitionForm"); index = 100; return node?.type(node.props); },
    button: (label: string) => elements(render()).find(e => e.type === "button" && text(e) === label) };
}
const result = { success: true, data: { rows: [], detail: null, hasMore: false, dashboard: { waiting: 2, approved: 1, ordered: 0, received: 3, estimated: 123000, actual: null, month: "2026-10" } } };
test("procurement dashboard has loading/error/retry states and renders only authoritative values", async () => {
  const pending: any[] = [];
  const h = harness("PROCUREMENT", { procurementReadAction: () => new Promise(resolve => pending.push(resolve)) });
  assert.match(text(h.render()), /Memuat pengadaan/);
  pending.shift()({ success: false, error: "Read unavailable" }); await flush();
  assert.match(text(h.render()), /Read unavailable/); assert.doesNotMatch(text(h.render()), /Rp0/);
  h.button("Coba lagi").props.onClick(); h.render(); pending.shift()(result); await flush();
  assert.match(text(h.render()), /Menunggu Persetujuan.*2.*Estimasi Nilai Pengadaan Bulan Ini.*Rp123.000.*Nilai Pembelian Aktual Bulan Ini.*Belum diketahui/);
});
test("Finance defaults to pending approvals; Admin has oversight without creation controls; stale reads are discarded", async () => {
  const requests: any[] = [];
  const h = harness("FINANCE", { procurementReadAction: (input: any) => new Promise(resolve => requests.push({ input, resolve })) });
  h.render(); assert.equal(requests[0].input.status, "WAITING_APPROVAL"); assert.equal(h.button("Permintaan Baru"), undefined);
  h.button("Riwayat").props.onClick(); h.render(); assert.equal(requests[1].input.status, "");
  requests[1].resolve(result); await flush(); requests[0].resolve({ success: false, error: "Old error" }); await flush();
  assert.doesNotMatch(text(h.render()), /Old error/); assert.match(text(h.render()), /Belum ada permintaan/);
  const admin = harness("ADMIN", { procurementReadAction: async () => result }); admin.render(); await flush();
  assert.equal(admin.button("Permintaan Baru"), undefined);
});
test("draft form blocks duplicate/offline writes and preserves exact interrupted intent across remount", async () => {
  const requests: any[] = [], storage = new Map<string, string>();
  const actions = { procurementReadAction: async () => result, procurementWriteAction: (input: any) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) };
  const h = harness("PROCUREMENT", actions, storage); h.render(); await flush();
  h.button("Permintaan Baru").props.onClick();
  const form = elements(h.render()).find(e => e.type === "form");
  const event = { preventDefault() {}, currentTarget: { data: { itemName: "Chair", category: "FURNITURE", quantity: "2", unit: "pcs", estimatedUnitPrice: "100000", priority: "NORMAL", reason: "Seating", vendor: "", productUrl: "", neededDate: "", notes: "" } } };
  h.navigator.onLine = false; form.props.onSubmit(event); assert.equal(requests.length, 0);
  h.navigator.onLine = true; form.props.onSubmit(event); form.props.onSubmit(event); assert.equal(requests.length, 1);
  assert.equal(requests[0].input.data.estimatedTotal, undefined); assert.equal(requests[0].input.actorId, undefined);
  const exact = JSON.stringify(requests[0].input);
  requests[0].reject(new Error("connection interrupted")); await flush();
  assert.equal(h.button("Permintaan Baru").props.disabled, true); assert.equal(storage.size, 1);
  const recovered = harness("PROCUREMENT", actions, storage); recovered.render(); await flush();
  assert.equal(requests.length, 1); await recovered.button("Ulangi permintaan yang sama").props.onClick();
  assert.equal(JSON.stringify(requests[1].input), exact);
  requests[1].resolve({ success: true, data: { id: requests[1].input.id, revision: 1 } }); await flush();
  assert.equal(storage.size, 0); assert.equal(recovered.button("Permintaan Baru").props.disabled, false);
});

const request = {
  id: randomUUID(), revision: 3, referenceNumber: "PR-20261008-12345678-1234-4123-8123-123456789012",
  itemName: "Mesin kopi untuk area pelayanan", category: "COFFEE_EQUIPMENT", priority: "IMPORTANT", status: "WAITING_APPROVAL",
  quantity: 2, unit: "unit", estimatedUnitPrice: 100000, estimatedTotal: 200000, actualUnitPrice: null, actualTotal: null,
  vendor: "Toko Kopi", productUrl: "https://example.com/item", neededDate: "2026-10-20T00:00:00Z", reason: "Penggantian peralatan", notes: "Catatan permintaan",
  createdBy: "buyer", creator: { name: "Petugas Pengadaan" }, decisionActor: { name: "Petugas Keuangan" },
  createdAt: "2026-10-08T01:00:00Z", updatedAt: "2026-10-08T02:00:00Z", decidedAt: null, decisionNote: "Catatan keputusan",
  orderedAt: null, receivedAt: null, cancelledAt: null, cancellationReason: null,
  events: [{ key: "event", operation: "SUBMIT", fromStatus: "DRAFT", toStatus: "WAITING_APPROVAL", actor: { name: "Petugas Pengadaan" }, createdAt: "2026-10-08T02:00:00Z", revision: 3, note: "Diajukan untuk ditinjau" }],
};
test("responsive cards and table retain server amounts, full references, filters and pagination", async () => {
  const reads: any[] = [];
  const h = harness("FINANCE", { procurementReadAction: async (input: any) => { reads.push(input); return { ...result, data: { ...result.data, rows: [request], hasMore: true } }; } });
  h.render(); await flush();
  const tree = h.render();
  for (const container of elements(tree).filter(e => e.type === "article" || e.type === "table")) {
    assert.match(text(container), /Mesin kopi.*Menunggu Persetujuan.*Penting.*Rp200.000.*Belum diketahui/);
    assert.equal(elements(container).find(e => e.type === "button").props["aria-label"], `Detail ${request.itemName}`);
    const reference = elements(container).find(e => e.type?.name === "ReferenceNumber");
    const expanded = reference.type(reference.props);
    const summary = elements(expanded).find(e => e.type === "summary");
    assert.match(text(summary), /…/);
    assert.ok(text(expanded).includes(request.referenceNumber));
    assert.match(text(expanded), /Gunakan nomor lengkap sebagai acuan/);
    assert.ok(elements(expanded).some(e => e.props.className?.includes("select-all") && text(e) === request.referenceNumber));
  }
  const select = elements(tree).find(e => e.type === "select");
  select.props.onChange({ target: { value: "APPROVED" } }); h.render(); await flush();
  assert.equal(reads.at(-1).status, "APPROVED"); assert.equal(reads.at(-1).page, 1);
  h.button("Berikutnya").props.onClick(); h.render(); await flush();
  assert.equal(reads.at(-1).page, 2);
  const detail = elements(h.render()).find(e => e.type === "button" && text(e) === "Detail");
  detail.props.onClick(); h.render(); await flush(); assert.equal(reads.at(-1).id, request.id);
});
test("grouped details preserve every field and event; approval UI retains role and self-approval restrictions", async () => {
  const writes: any[] = [];
  const actions = (detail = request) => ({ procurementReadAction: async () => ({ ...result, data: { ...result.data, detail } }), procurementDecisionAction: async (input: any) => { writes.push(input); return { success: true, data: { id: request.id } }; } });
  const h = harness("FINANCE", actions()); h.render(); await flush();
  const tree = h.render();
  for (const title of ["Informasi Barang", "Informasi Pengadaan", "Persetujuan", "Pembelian", "Riwayat Aktivitas"]) assert.ok(text(tree).includes(title));
  assert.equal(elements(tree).filter(e => e.type === "dt").length, 21);
  for (const value of [request.referenceNumber, request.reason, request.notes, request.vendor, request.decisionNote, request.creator.name, request.decisionActor.name, request.events[0].note]) assert.ok(text(tree).includes(value));
  assert.ok(elements(tree).some(e => e.type === "a" && e.props.href === request.productUrl));
  assert.match(text(tree), /Persetujuan diajukan.*Draf.*Menunggu Persetujuan/);
  const form = h.transition();
  const options = elements(form).filter(e => e.type === "option");
  assert.deepEqual(options.map(e => e.props.value), ["APPROVE", "REJECT"]);
  elements(form).find(e => e.type === "select").props.onChange({ target: { value: "REJECT" } });
  assert.equal(elements(h.transition()).find(e => e.type === "textarea").props.required, true);
  elements(form).find(e => e.type === "select").props.onChange({ target: { value: "APPROVE" } });
  h.transition().props.onSubmit({ preventDefault() {}, currentTarget: { data: { note: "Disetujui" } } }); await flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].operation, "APPROVE"); assert.equal(writes[0].id, request.id); assert.equal(writes[0].revision, 3);
  assert.match(h.confirmations[0], /Setujui pengadaan/);
  for (const role of ["ADMIN", "PROCUREMENT"]) {
    const restricted = harness(role, actions()); restricted.render(); await flush();
    assert.ok(!elements(restricted.transition()).some(e => e.type === "option" && ["APPROVE", "REJECT"].includes(e.props.value)));
  }
  const own = harness("FINANCE", actions({ ...request, createdBy: "actor" })); own.render(); await flush(); assert.equal(own.transition(), null);
});
