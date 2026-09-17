import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { PrismaClient } from "../../generated/prisma/client";
import * as printing from "../../lib/printing/printer";
import { FakePrinterAdapter } from "../../lib/printing/testing/fake-printer";

const require = createRequire(import.meta.url);
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
type Element = { type: unknown; key?: string; props: Record<string, unknown> };
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
type Component = (props: never) => unknown;
function load(file: string, mocks: Record<string, unknown>) {
  const code = ts.transpileModule(source(file), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const exports: Record<string, Component> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected UI dependency: ${id}`);
  } });
  return exports;
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function pending() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-09-16T18:30:00.000Z";
function order(n = 1, status = "PAID") {
  return {
    id: id(n), orderNumber: `AR-${String(n).padStart(6, "0")}`, status, orderType: "DINE_IN",
    total: 44000, createdAt: date, paidAt: status === "PAID" ? date : null, cancelledAt: status === "CANCELLED" ? date : null,
    cashier: { id: id(100), name: "Original cashier" },
    shift: { id: id(200), status: "CLOSED", openedAt: date, closedAt: date, cashier: { id: id(100), name: "Shift owner" } },
    items: [{ id: id(300), productId: id(400), productName: "Saved coffee", unitPrice: 22000, quantity: 2, notes: "Less sweet", lineTotal: 44000 }],
    payments: status === "PAID" ? [{ id: id(500), method: "CASH", status: "SUCCEEDED", amount: 44000,
      cashReceived: 50000, changeAmount: 6000, edcReference: null, createdAt: date, updatedAt: date, succeededAt: date }] : [],
  };
}
const receipt = {
  orderNumber: "AR-000001", orderType: "DINE_IN", cashier: "Original cashier", createdAt: date, paidAt: date, total: 44000,
  items: [{ name: "Saved coffee", unitPrice: 22000, quantity: 2, lineTotal: 44000 }],
  payment: { method: "CASH", amount: 44000, cashReceived: 50000, changeAmount: 6000, edcReference: null, succeededAt: date },
};
const history = (orders = [order()], nextCursor: unknown = null) => ({ success: true, orders, nextCursor });

// Same isolated component approach as existing POS tests. Hook state is scoped
// per mounted/keyed component so the real ReceiptPanel and print job run too.
function harness(initial: unknown = history(), adapter?: printing.PrinterAdapter, actions?: Record<string, unknown>) {
  const reads = { list: [] as Array<ReturnType<typeof pending> & { input: unknown }>,
    detail: [] as Array<ReturnType<typeof pending> & { input: unknown }>, receipt: [] as Array<ReturnType<typeof pending> & { input: unknown }> };
  const capture = (kind: keyof typeof reads) => (input: unknown) => {
    const request = { ...pending(), input };
    reads[kind].push(request);
    return request.promise;
  };
  type Instance = { slots: unknown[]; cleanups: Array<() => void> };
  const instances = new Map<string, Instance>();
  let active!: Instance;
  let cursor = 0;
  const hooks = {
    useState(initialValue: unknown) {
      const instance = active;
      const index = cursor++;
      if (!(index in instance.slots)) instance.slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [instance.slots[index], (value: unknown) => {
        instance.slots[index] = typeof value === "function" ? value(instance.slots[index]) : value;
      }];
    },
    useRef(initialValue: unknown) {
      const index = cursor++;
      if (!(index in active.slots)) active.slots[index] = { current: initialValue };
      return active.slots[index];
    },
    useEffect(effect: () => () => void) {
      const index = cursor++;
      if (!(index in active.slots)) { active.slots[index] = true; active.cleanups.push(effect()); }
    },
  };
  const panel = load("../pos/receipt-panel.tsx", { react: hooks, "@/lib/printing/printer": printing });
  const component = load("./order-history.tsx", {
    react: hooks,
    "@/lib/orders/actions": actions ?? {
      listOrderHistoryAction: capture("list"), getHistoricalOrderAction: capture("detail"), getReceiptAction: capture("receipt"),
    },
    "../pos/receipt-panel": { ReceiptPanel: (props: object) => panel.ReceiptPanel({ ...props, printerAdapter: adapter } as never) },
  });
  let mounted = true;
  function render() {
    const seen = new Set<string>();
    function expand(node: unknown, path: string): unknown {
      if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`));
      if (!node || typeof node !== "object" || !("props" in node)) return node;
      const element = node as Element;
      if (typeof element.type === "function") {
        const key = `${path}/${element.type.name}:${element.key ?? ""}`;
        seen.add(key);
        if (!instances.has(key)) instances.set(key, { slots: [], cleanups: [] });
        active = instances.get(key)!;
        cursor = 0;
        return expand(element.type(element.props), key);
      }
      return { ...element, props: { ...element.props, children: expand(element.props.children, `${path}/children`) } };
    }
    const tree = mounted ? expand({ type: component.OrderHistory, props: { initial } }, "root") : null;
    for (const [key, instance] of instances) {
      if (!seen.has(key)) { instance.cleanups.forEach(cleanup => cleanup()); instances.delete(key); }
    }
    return tree;
  }
  const button = (label: string) => elements(render()).find(e => e.type === "button" &&
    (e.props["aria-label"] === label || text(e).trim() === label));
  return { reads, render, button,
    click(label: string) { const found = button(label); assert.ok(found, label); (found.props.onClick as () => void)(); },
    search(value: string) {
      const input = elements(render()).find(e => e.type === "input")!;
      (input.props.onChange as (event: unknown) => void)({ target: { value } });
      const form = elements(render()).find(e => e.type === "form")!;
      (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    },
    unmount() { mounted = false; render(); },
  };
}

test("history route authenticates before history reads and does not require an open shift", async () => {
  let authenticated = false;
  let reads = 0;
  const initial = history();
  const page = load("./page.tsx", {
    "next/link": { default: "a" }, "./order-history": { OrderHistory: "History" },
    "@/lib/auth/authorization": { requireUser: async () => { if (!authenticated) throw new Error("redirect login"); } },
    "@/lib/orders/actions": { listOrderHistoryAction: async () => { reads++; return initial; } },
  });
  await assert.rejects(async () => page.default(undefined as never), /redirect login/);
  assert.equal(reads, 0);
  authenticated = true;
  const tree = await page.default(undefined as never);
  assert.equal(reads, 1);
  assert.equal(elements(tree).find(e => e.type === "History")!.props.initial, initial);
  assert.match(source("../page.tsx"), /href="\/orders"/);
  assert.doesNotMatch(source("./page.tsx") + source("./order-history.tsx"), /getActiveShift|confirmManualPayment|recordManualPayment|createOrderAction|editOrderAction|cancelOrderAction|\/lib\/db|localStorage|sessionStorage/);
  const loading = load("./loading.tsx", {}).default(undefined as never);
  assert.match(text(loading), /Memuat riwayat/);
  assert.equal(elements(loading)[0].props.role, "status");
});

test("history loading, empty response and failed reads with explicit retry", async () => {
  const ui = harness();
  ui.click("Muat ulang halaman");
  assert.match(text(ui.render()), /Memuat riwayat/);
  assert.doesNotMatch(text(ui.render()), /Belum ada riwayat/);
  ui.reads.list[0].reject(new Error("secret connection"));
  await flush();
  assert.match(text(ui.render()), /Riwayat belum dapat dimuat/);
  assert.doesNotMatch(text(ui.render()), /secret|Belum ada riwayat/);
  ui.click("Coba lagi riwayat");
  ui.reads.list[1].resolve(history([]));
  await flush();
  assert.match(text(ui.render()), /Belum ada riwayat pesanan/);
  assert.equal(ui.button("Halaman berikutnya"), undefined);
  const failedInitial = harness({ success: false, code: "UPDATE_FAILED", error: "Status perubahan belum dapat dipastikan" });
  assert.match(text(failedInitial.render()), /Riwayat belum dapat dimuat/);
  failedInitial.click("Coba lagi riwayat");
  failedInitial.reads.list[0].resolve(history());
  await flush();
  assert.ok(failedInitial.button("Lihat AR-000001"));
});

test("pagination forwards the exact server cursor and search normalizes an exact number, resetting pagination", async () => {
  const cursor = { createdAt: date, id: id(1) };
  const ui = harness(history([order()], cursor));
  ui.click("Halaman berikutnya");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.reads.list[0].input)), { cursor });
  ui.reads.list[0].resolve(history([order(2)]));
  await flush();
  assert.equal(ui.button("Lihat AR-000001"), undefined);
  assert.ok(ui.button("Lihat AR-000002"));
  assert.equal(ui.button("Halaman berikutnya"), undefined);
  ui.click("Halaman pertama");
  assert.equal(JSON.stringify(ui.reads.list[1].input), "{}");
  ui.reads.list[1].resolve(history());
  await flush();
  ui.search("  ar-000042  ");
  assert.equal(JSON.stringify(ui.reads.list[2].input), '{"orderNumber":"AR-000042"}');
  ui.reads.list[2].resolve(history([order(42)]));
  await flush();
  assert.match(text(ui.render()), /Pencarian tepat:.*AR-000042/);
  assert.ok(ui.button("Lihat AR-000042"));
  ui.search("000");
  ui.reads.list[3].resolve({ success: false, code: "INVALID_INPUT" });
  await flush();
  assert.match(text(ui.render()), /Masukkan nomor pesanan lengkap/);
  ui.click("Semua pesanan");
  assert.equal(JSON.stringify(ui.reads.list[4].input), "{}");
  ui.reads.list[4].resolve(history([]));
  await flush();
  assert.doesNotMatch(text(ui.render()), /Pencarian tepat/);
});

test("superseded list successes, action failures and transport failures cannot overwrite newer results", async () => {
  for (const stale of ["success", "failure", "throw"]) {
    const ui = harness();
    ui.search("AR-000001");
    ui.search("AR-000002");
    ui.reads.list[1].resolve(history([order(2)]));
    await flush();
    if (stale === "throw") ui.reads.list[0].reject(new Error("old error"));
    else ui.reads.list[0].resolve(stale === "success" ? history() : { success: false, code: "UPDATE_FAILED" });
    await flush();
    assert.ok(ui.button("Lihat AR-000002"));
    assert.equal(ui.button("Lihat AR-000001"), undefined);
    assert.doesNotMatch(text(ui.render()), /belum dapat dimuat/);
  }
});

test("detail loading and retry preserve saved values, timestamps and separate payment states", async () => {
  const ui = harness();
  ui.click("Lihat AR-000001");
  assert.equal(ui.reads.detail[0].input, id(1));
  assert.match(text(ui.render()), /Memuat detail/);
  ui.reads.detail[0].reject(new Error("private error"));
  await flush();
  assert.match(text(ui.render()), /Detail belum dapat dimuat/);
  assert.doesNotMatch(text(ui.render()), /private error/);
  ui.click("Coba lagi detail");
  ui.reads.detail[1].resolve({ success: true, order: order() });
  await flush();
  const content = text(ui.render());
  for (const value of ["Saved coffee", "Less sweet", "Rp22.000", "Rp44.000", "Rp50.000", "Rp6.000", "Original cashier", "Shift owner", "Lunas", "Berhasil", "17 Sep 2026", "01.30", "Dibayar", "Dibatalkan"]) assert.ok(content.includes(value), value);
  assert.ok(elements(ui.render()).some(e => e.type === "time" && e.props.dateTime === date));
  assert.ok(ui.button("Cetak ulang struk"));
});

test("unpaid and cancelled details cannot request a reprint", async () => {
  for (const status of ["UNPAID", "CANCELLED"]) {
    const saved = order(1, status);
    const ui = harness(history([saved]));
    ui.click("Lihat AR-000001");
    ui.reads.detail[0].resolve({ success: true, order: saved });
    await flush();
    assert.equal(ui.button("Cetak ulang struk"), undefined);
    assert.equal(ui.reads.receipt.length, 0);
    assert.match(text(ui.render()), /Belum ada pembayaran/);
  }
});

test("detail displays EDC reference and separate QRIS attempt states without cash fields", async () => {
  const saved = order();
  saved.orderType = "TAKEAWAY";
  const payment = saved.payments[0];
  const ui = harness();
  ui.click("Lihat AR-000001");
  ui.reads.detail[0].resolve({ success: true, order: { ...saved, payments: [
    { ...payment, id: id(501), method: "MIDTRANS_QRIS", status: "EXPIRED", cashReceived: null, changeAmount: null, succeededAt: null },
    { ...payment, method: "BCA_EDC", cashReceived: null, changeAmount: null, edcReference: "APPROVED-42" },
  ] } });
  await flush();
  assert.match(text(ui.render()), /Takeaway/);
  assert.match(text(ui.render()), /QRIS.*Kedaluwarsa.*BCA EDC.*Berhasil.*Referensi EDC:.*APPROVED-42/);
  assert.doesNotMatch(text(ui.render()), /Uang diterima|Kembalian/);
});

test("changing selection or refreshing history invalidates old detail and receipt reads", async () => {
  for (const stale of ["success", "failure", "throw"]) {
    const ui = harness(history([order(), order(2)]));
    ui.click("Lihat AR-000001");
    ui.click("Lihat AR-000002");
    ui.reads.detail[1].resolve({ success: true, order: { ...order(2), items: [{ ...order(2).items[0], productName: "New selection" }] } });
    await flush();
    if (stale === "throw") ui.reads.detail[0].reject(new Error("stale error"));
    else ui.reads.detail[0].resolve(stale === "success" ? { success: true, order: order() } : { success: false });
    await flush();
    assert.match(text(ui.render()), /New selection/);
    assert.doesNotMatch(text(ui.render()), /Saved coffee|Detail belum dapat dimuat/);
    ui.click("Cetak ulang struk");
    ui.click("Lihat AR-000001");
    ui.reads.detail[2].resolve({ success: true, order: order() });
    await flush();
    if (stale === "throw") ui.reads.receipt[0].reject(new Error("stale receipt"));
    else ui.reads.receipt[0].resolve(stale === "success" ? { success: true, receipt: { ...receipt, orderNumber: "AR-000002" } } : { success: false });
    await flush();
    assert.doesNotMatch(text(ui.render()), /COPY|Struk belum dapat dimuat/);
    ui.click("Lihat AR-000002");
    ui.click("Muat ulang halaman");
    ui.reads.detail[3].resolve({ success: true, order: order(2) });
    await flush();
    assert.match(text(ui.render()), /Pilih pesanan/);
    assert.equal(ui.button("Cetak ulang struk"), undefined);
    ui.unmount();
    ui.reads.list[0].resolve(history());
    await flush();
    assert.equal(ui.render(), null);
  }
});

test("paid reprint fetches the authorized receipt, marks preview and output COPY, blocks duplicate taps, and retries printer failure", async () => {
  const print = pending();
  const adapter = new FakePrinterAdapter([async () => { await print.promise; }]);
  const ui = harness(history(), adapter);
  ui.click("Lihat AR-000001");
  ui.reads.detail[0].resolve({ success: true, order: order() });
  await flush();
  const read = ui.button("Cetak ulang struk")!.props.onClick as () => void;
  read(); read();
  assert.equal(ui.reads.receipt.length, 1);
  assert.equal(ui.reads.receipt[0].input, id(1));
  assert.equal(ui.button("Cetak ulang struk")!.props.disabled, true);
  ui.reads.receipt[0].resolve({ success: true, receipt: { ...receipt, cashier: "Receipt from server" } });
  await flush();
  assert.match(text(ui.render()), /COPY \/ SALINAN/);
  assert.match(text(ui.render()), /Receipt from server/);
  assert.equal(adapter.attempts.length, 0);
  const click = ui.button("Cetak Salinan")!.props.onClick as () => void;
  click(); click();
  assert.equal(adapter.attempts.length, 1);
  assert.equal(ui.button("Mencetak...")!.props.disabled, true);
  print.reject(new Error("secret printer transport"));
  await flush();
  assert.match(text(ui.render()), /Struk gagal dicetak.*Pembayaran tetap berhasil/);
  assert.doesNotMatch(text(ui.render()), /secret printer/);
  ui.click("Coba Cetak Lagi");
  await flush();
  assert.equal(adapter.attempts.length, 2);
  assert.strictEqual(adapter.attempts[0], adapter.attempts[1]);
  assert.match(adapter.attempts[1].text, /^AROOM Coffee Bar\nCOPY\n/);
  assert.match(adapter.attempts[1].text, /Saved coffee/);
  assert.match(text(ui.render()), /Permintaan cetak berhasil/);
  assert.equal(ui.button("Cetak Salinan")!.props.disabled, true);
  click();
  await flush();
  assert.equal(adapter.attempts.length, 2);
  assert.equal(ui.reads.receipt.length, 1);
});

test("receipt read failures require explicit retry; default printer reports its configuration error", async () => {
  const ui = harness();
  ui.click("Lihat AR-000001");
  ui.reads.detail[0].resolve({ success: true, order: order() });
  await flush();
  ui.click("Cetak ulang struk");
  ui.reads.receipt[0].resolve({ success: false, code: "FORBIDDEN" });
  await flush();
  assert.equal(ui.button("Cetak Salinan"), undefined);
  ui.click("Coba lagi struk");
  ui.reads.receipt[1].reject(new Error("offline"));
  await flush();
  assert.match(text(ui.render()), /Struk belum dapat dimuat/);
  ui.click("Coba lagi struk");
  ui.reads.receipt[2].resolve({ success: true, receipt });
  await flush();
  ui.click("Cetak Salinan");
  await flush();
  assert.match(text(ui.render()), /Printer belum dikonfigurasi.*Pembayaran tetap berhasil/);
  assert.ok(ui.button("Coba Cetak Lagi"));
});

test("closing and reopening a reprint cannot overlap an active print, and later explicit copies remain marked", async () => {
  const print = pending();
  const adapter = new FakePrinterAdapter([async () => { await print.promise; }]);
  const ui = harness(history(), adapter);
  ui.click("Lihat AR-000001");
  ui.reads.detail[0].resolve({ success: true, order: order() });
  await flush();
  ui.click("Cetak ulang struk");
  ui.reads.receipt[0].resolve({ success: true, receipt });
  await flush();
  ui.click("Cetak Salinan");
  try {
    ui.click("Tutup struk");
    ui.click("Cetak ulang struk");
    assert.equal(ui.reads.receipt.length, 2);
    ui.reads.receipt[1].resolve({ success: true, receipt });
    await flush();
    ui.click("Cetak Salinan");
    await flush();
    assert.match(text(ui.render()), /Printer sedang digunakan/);
    assert.equal(adapter.attempts.length, 1);
  } finally { print.resolve(undefined); }
  await flush();
  assert.doesNotMatch(text(ui.render()), /Permintaan cetak berhasil/);
  ui.click("Coba Cetak Lagi");
  await flush();
  assert.equal(adapter.attempts.length, 2);
  for (const attempt of adapter.attempts) assert.match(attempt.text, /\nCOPY\n/);
  assert.match(text(ui.render()), /Permintaan cetak berhasil/);
});

test("history UI with real services enforces cashier ownership, allows admin across closed shifts, and reprinting never writes financial state", async t => {
  const serverOnlyPath = require.resolve("server-only");
  const original = require.cache[serverOnlyPath];
  require.cache[serverOnlyPath] = { exports: {} } as NodeModule;
  t.after(() => { if (original) require.cache[serverOnlyPath] = original; else delete require.cache[serverOnlyPath]; });
  const { listOrderHistory, getHistoricalOrder } = await import("../../lib/orders/history");
  const { getReceipt } = await import("../../lib/orders/receipt");
  const rows = [order(), order(2), order(3, "UNPAID")].map((value, index) => ({
    ...value, createdAt: new Date(date), paidAt: value.paidAt ? new Date(date) : null,
    // First order was created by an assisting Admin; visibility is shift ownership.
    cashier: { id: id(index === 0 ? 999 : 100), name: value.cashier.name },
    shift: { ...value.shift, cashierId: id(index === 1 ? 101 : 100), openedAt: new Date(date), closedAt: new Date(date) },
    items: value.items.map(item => ({ ...item, productNameSnapshot: item.productName, unitPriceSnapshot: item.unitPrice })),
    payments: value.payments.map(payment => ({ ...payment, createdAt: new Date(date), updatedAt: new Date(date), succeededAt: new Date(date) })),
  }));
  const before = structuredClone(rows);
  let writes = 0;
  const db = { order: new Proxy({
    findMany: async ({ where, take }: { where: { shift: { cashierId?: string } }; take: number }) =>
      rows.filter(row => !where.shift.cashierId || row.shift.cashierId === where.shift.cashierId).slice(0, take),
    findUnique: async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null,
  }, { get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    return () => { writes++; throw new Error("Financial write forbidden in history"); };
  } }), payment: { create: () => { writes++; assert.fail("Unexpected payment"); } },
  shift: { findFirst: () => assert.fail("No active shift required") },
  $transaction: () => { writes++; assert.fail("Unexpected transaction"); } } as unknown as PrismaClient;
  const actor: { id: string; role: "CASHIER" | "ADMIN" } = { id: id(100), role: "CASHIER" };
  const actions = {
    listOrderHistoryAction: async (input: unknown) => ({ success: true, ...await listOrderHistory(db, actor, input) }),
    getHistoricalOrderAction: async (input: unknown) => ({ success: true, order: await getHistoricalOrder(db, actor, input) }),
    getReceiptAction: async (input: string) => ({ success: true, receipt: await getReceipt(db, actor, input) }),
  };
  const printer = new FakePrinterAdapter([() => { throw new Error("disconnected"); }]);
  const ui = harness(await actions.listOrderHistoryAction({}), printer, actions);
  assert.ok(ui.button("Lihat AR-000001"));
  assert.ok(ui.button("Lihat AR-000003"));
  assert.equal(ui.button("Lihat AR-000002"), undefined);
  await assert.rejects(actions.getHistoricalOrderAction(id(2)), { code: "FORBIDDEN" });
  await assert.rejects(actions.getReceiptAction(id(2)), { code: "FORBIDDEN" });
  await assert.rejects(actions.getReceiptAction(id(3)), { code: "ORDER_NOT_FOUND" });
  ui.click("Lihat AR-000001");
  await flush();
  // Permission can change after detail was loaded; receipt service checks again.
  actor.id = id(101);
  ui.click("Cetak ulang struk");
  await flush();
  assert.equal(ui.button("Cetak Salinan"), undefined);
  assert.equal(printer.attempts.length, 0);
  actor.id = id(100);
  ui.click("Coba lagi struk");
  await flush();
  ui.click("Cetak Salinan");
  await flush();
  ui.click("Coba Cetak Lagi");
  await flush();
  assert.equal(printer.attempts.length, 2);
  assert.match(printer.attempts[1].text, /\nCOPY\n/);
  actor.role = "ADMIN";
  ui.click("Muat ulang halaman");
  await flush();
  assert.ok(ui.button("Lihat AR-000002"));
  ui.click("Lihat AR-000002");
  await flush();
  ui.click("Cetak ulang struk");
  await flush();
  ui.click("Cetak Salinan");
  await flush();
  assert.equal(printer.attempts.length, 3);
  assert.equal(writes, 0);
  assert.deepEqual(rows, before);
});
