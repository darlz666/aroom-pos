import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ReportError } from "../../../lib/reports/domain";

const require = createRequire(import.meta.url);
function load(file: string, mocks: Record<string, unknown>) {
  // Execute the real modules with isolated Next/request boundaries, like POS UI tests.
  const exports: Record<string, (...args: any[]) => any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  } }).outputText;
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "./transaction-actions") return { TransactionActions: "Actions" };
    if (id === "../orders/receipt") return {};
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  return exports;
}
type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  return [el, ...elements(el.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
const report = { businessDate: "2026-09-17", paidSales: 99000, paidOrderCount: 3,
  cashTotal: 22000, edcTotal: 33000, qrisTotal: 44000, transactions: [], shifts: [{
    id: "shift", status: "CLOSED", cashierName: "Cashier", openedAt: "2026-09-16T16:00:00.000Z",
    closedAt: "2026-09-17T18:00:00.000Z", openingCash: 100000, expectedCash: 180000,
    countedCash: 179000, variance: -1000,
  }] };
const initial = { success: true, report };

test("report action requires report visibility before report reads, preserves redirects and sanitizes failures", async () => {
  let role = "STOCK_MANAGEMENT";
  let reads = 0;
  let authFailure: Error | null = null;
  let serviceFailure: Error | null = null;
  const redirect = new Error("redirect");
  const db = {};
  const { getDailyReportAction: action } = load("../../../lib/reports/action.ts", {
    "next/navigation": { unstable_rethrow: (e: unknown) => { if (e === redirect) throw e; } },
    "../auth/authorization": { requireReportReader: async () => {
      if (authFailure) throw authFailure;
      if (!["ADMIN", "CASHIER", "FINANCE"].includes(role)) throw redirect;
      return { id: "admin", role };
    } },
    "../db": { prisma: db }, "./domain": { ReportError },
    "./service": { getDailyReport: async (client: unknown, actor: unknown, date: unknown) => {
      reads++;
      assert.equal(client, db);
      assert.deepEqual(actor, { id: "admin", role });
      assert.equal(date, "2026-09-17");
      if (serviceFailure) throw serviceFailure;
      return report;
    } },
  });
  for (role of ["STOCK_MANAGEMENT", "ANONYMOUS"]) await assert.rejects(action("2026-09-17"), e => e === redirect);
  assert.equal(reads, 0);
  for (role of ["ADMIN", "CASHIER", "FINANCE"]) assert.equal((await action("2026-09-17")).report, report);
  serviceFailure = new ReportError("INVALID_DATE");
  assert.equal((await action("2026-09-17")).code, "INVALID_DATE");
  serviceFailure = new Error("database credential secret");
  const failure = await action("2026-09-17");
  assert.equal(failure.success, false);
  assert.equal(failure.code, "UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failure), /secret|credential|paidSales/);
  const before = reads;
  authFailure = new Error("auth database secret");
  assert.equal((await action("2026-09-17")).code, "UNAVAILABLE");
  assert.equal(reads, before);
});

test("report route authorizes before loading, and Admin area links to it", async () => {
  let allowed = false;
  let reads = 0;
  const auth = { requireReportReader: async () => { if (!allowed) throw new Error("redirect"); return { role: "ADMIN" }; }, requireRole: async (role: string) => {
    assert.equal(role, "ADMIN");
    if (!allowed) throw new Error("redirect");
    return { name: "Admin" };
  } };
  const page = load("./page.tsx", {
    "next/link": { default: "a" }, "./daily-report": { DailyReportPanel: "Report" },
    "@/lib/auth/authorization": auth,
    "@/lib/reports/domain": { jakartaBusinessDate: () => "2026-09-17" },
    "@/lib/reports/action": { getDailyReportAction: async (date: string) => { reads++; assert.equal(date, report.businessDate); return initial; } },
  });
  await assert.rejects(page.default(), /redirect/);
  assert.equal(reads, 0);
  allowed = true;
  const tree = await page.default();
  assert.equal(reads, 1);
  assert.equal(elements(tree).find(e => e.type === "Report")!.props.initial, initial);
  const admin = load("../page.tsx", { "next/link": { default: "a" }, "@/lib/auth/authorization": auth });
  assert.ok(elements(await admin.default()).some(e => e.props.href === "/admin/reports"));
});

test("report summary displays server totals, persisted reconciliation, Jakarta times and unset open values", () => {
  const { DailyReportSummary: summary } = load("./daily-report.tsx", { react: {}, "@/lib/reports/action": {} });
  const tree = summary({ report });
  const content = text(tree);
  for (const value of ["2026-09-17", "Rp99.000", "Rp22.000", "Rp33.000", "Rp44.000", "Rp100.000", "Rp180.000", "Rp179.000", "Rp-1.000", "16 Sep 2026", "23.00", "18 Sep 2026", "01.00"]) {
    assert.ok(content.includes(value), value);
  }
  assert.equal(elements(tree).filter(e => ["button", "input", "form"].includes(String(e.type))).length, 0);
  const open = text(summary({ report: { ...report, shifts: [{ ...report.shifts[0], status: "OPEN", closedAt: null, countedCash: null, variance: null }] } }));
  assert.match(open, /Belum ditutup/);
  assert.equal(open.split("Belum ditetapkan").length - 1, 2);
  const empty = text(summary({ report: { ...report, paidSales: 0, paidOrderCount: 0, shifts: [] } }));
  assert.match(empty, /Belum ada pembayaran berhasil/);
  assert.match(empty, /Tidak ada shift/);
  assert.match(empty, /Belum ada transaksi lunas pada tanggal ini\./);
});

test("transaction table follows reconciliation, formats saved values and distinguishes unknown costs from zero", () => {
  const { DailyReportSummary: summary } = load("./daily-report.tsx", { react: {}, "@/lib/reports/action": {} });
  const transaction = { orderId: "order", orderNumber: "AROOM-001", paidAt: "2026-09-16T17:05:00.000Z",
    customerLabel: null, productsLabel: "Americano x2, Aroomsbrew x1", quantity: 3, paymentMethod: "CASH",
    sellingPrice: 66000, totalRevenue: 66000, voucherDiscount: 0, posPromo: 0, receivable: 0,
    hpp: null, adsCost: 0, totalDiscount: 0, grossProfit: null, netRevenue: null };
  for (const [method, label] of [["CASH", "Tunai"], ["BCA_EDC", "BCA EDC"], ["MIDTRANS_QRIS", "QRIS"]]) {
    const tree = summary({ report: { ...report, transactions: [{ ...transaction, paymentMethod: method }] } });
    assert.deepEqual(elements(tree).filter(e => e.type === "section").map(e => e.props["aria-label"]),
      ["Penjualan harian", "Rekonsiliasi shift", "Detail transaksi"]);
    assert.ok(elements(tree).some(e => String(e.props.className).includes("overflow-x-auto")));
    const table = elements(tree).find(e => e.type === "table")!;
    const rows = elements(table).filter(e => e.type === "tr");
    assert.equal(rows.length, 2);
    assert.deepEqual(elements(rows[0]).filter(e => e.type === "th").map(text),
      ["No. Pesanan", "Tanggal", "Jam", "Pelanggan / Meja", "Produk", "Qty", "Status Pembayaran", "Harga Jual", "Total Omzet", "Diskon Voucher", "Promo POS", "Piutang", "HPP", "Iklan", "Total Potongan", "Gross Profit", "Pendapatan Bersih", "Aksi"]);
    const cells = elements(rows[1]).filter(e => e.type === "td" || e.type === "th").map(e => text(e).replace(/\s+/g, " "));
    assert.equal(cells.length, 18);
    assert.equal(cells[0], "AROOM-001");
    assert.equal(cells[1], "17/09/2026");
    assert.equal(cells[2], "00:05 WIB");
    assert.deepEqual(cells.slice(3, 17), ["-", "Americano x2, Aroomsbrew x1", "3", `Lunas · ${label}`,
      "Rp66.000", "Rp66.000", "Rp0", "Rp0", "Rp0", "-", "Rp0", "Rp0", "-", "-"]);
  }
});

function harness(value: unknown = initial) {
  const slots: unknown[] = [];
  let index = 0;
  const requests: { date: unknown; resolve: (value: unknown) => void; reject: (e: Error) => void }[] = [];
  const { DailyReportPanel: panel } = load("./daily-report.tsx", {
    react: {
      useState: (initialValue: unknown) => { const i = index++; if (!(i in slots)) slots[i] = initialValue; return [slots[i], (v: unknown) => { slots[i] = v; }]; },
      useRef: (initialValue: unknown) => { const i = index++; if (!(i in slots)) slots[i] = { current: initialValue }; return slots[i]; },
    },
    "@/lib/reports/action": { getDailyReportAction: (date: unknown) => new Promise((resolve, reject) => requests.push({ date, resolve, reject })) },
  });
  const render = () => { index = 0; return panel({ initialDate: report.businessDate, initial: value }); };
  const find = (type: string) => elements(render()).find(e => e.type === type)!;
  return { requests, render,
    submit() { (find("form").props.onSubmit as (event: unknown) => void)({ preventDefault() {} }); },
    change(value: string) { (find("input").props.onChange as (event: unknown) => void)({ target: { value } }); },
    summary() { return elements(render()).find(e => typeof e.type === "function")?.props.report; },
  };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("date changes clear totals, duplicate reads are guarded and superseded responses are discarded", async () => {
  const h = harness();
  assert.equal(h.summary(), report);
  h.submit(); h.submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].date, "2026-09-17");
  assert.equal(h.summary(), undefined);
  assert.match(text(h.render()), /Memuat laporan/);
  h.change("2026-09-18"); h.submit();
  h.requests[0].resolve(initial);
  await flush();
  assert.equal(h.summary(), undefined);
  const newer = { ...report, businessDate: "2026-09-18" };
  h.requests[1].resolve({ success: true, report: newer });
  await flush();
  assert.equal(h.summary(), newer);
  h.submit(); h.change("2026-09-19"); h.submit();
  h.requests[2].reject(new Error("stale secret"));
  await flush();
  assert.doesNotMatch(text(h.render()), /secret|Periksa koneksi/);
  h.requests[3].resolve({ success: false, error: "Laporan gagal" });
  await flush();
  assert.match(text(h.render()), /Laporan gagal/);
  assert.equal(h.summary(), undefined);
});

test("initial and transport failures show explicit retry without zero or stale totals", async () => {
  const h = harness({ success: false, error: "Tidak tersedia" });
  assert.equal(h.summary(), undefined);
  assert.match(text(h.render()), /Coba lagi/);
  h.submit();
  h.requests[0].reject(new Error("transport secret"));
  await flush();
  assert.match(text(h.render()), /Periksa koneksi/);
  assert.doesNotMatch(text(h.render()), /secret/);
  h.submit(); h.requests[1].resolve(initial);
  await flush();
  assert.equal(h.summary(), report);
});

const transaction = { orderId: "saved-order", orderNumber: "AR-42", paidAt: "2026-09-16T17:05:00.000Z",
  customerLabel: null, productsLabel: "Saved coffee x2", quantity: 2, paymentMethod: "CASH",
  sellingPrice: 43000, totalRevenue: 44000, voucherDiscount: 0, posPromo: 0, receivable: 0,
  hpp: null, adsCost: 0, totalDiscount: 0, grossProfit: null, netRevenue: null };

function actionHarness(component: string, props: Record<string, unknown>, mocks: Record<string, unknown> = {}) {
  const slots: unknown[] = [];
  let index = 0;
  const loaded = load("./transaction-actions.tsx", {
    react: {
      useState(initialValue: unknown) { const i = index++; if (!(i in slots)) slots[i] = initialValue; return [slots[i], (v: unknown) => { slots[i] = v; }]; },
      useRef(initialValue: unknown) { const i = index++; if (!(i in slots)) slots[i] = { current: initialValue }; return slots[i]; },
      useEffect() {},
    },
    "@/lib/reports/action": {}, "@/lib/printing/printer": {}, ...mocks,
  });
  const render = () => { index = 0; return loaded[component](props); };
  return { render, module: loaded };
}

test("role-specific action buttons select the correct saved transaction; admin mutations are disabled", () => {
  for (const role of ["ADMIN", "CASHIER", "FINANCE"]) {
    const h = actionHarness("TransactionActions", { transaction, role });
    const buttons = elements(h.render()).filter(e => e.type === "button");
    assert.deepEqual(buttons.map(e => e.props["aria-label"]), role === "ADMIN"
      ? ["Lihat detail", "Edit transaksi", "Cetak ulang struk", "Hapus transaksi"]
      : ["Lihat detail", "Cetak ulang struk"]);
    for (const e of buttons.filter(e => /Edit|Hapus/.test(String(e.props["aria-label"])))) {
      assert.equal(e.props.disabled, true);
      assert.equal(e.props.onClick, undefined);
      assert.match(String(e.props.title), /Belum didukung/);
    }
    (buttons[0].props.onClick as () => void)();
    const modal = elements(h.render()).find(e => e.type === h.module.TransactionModal)!;
    assert.equal(modal.props.transaction, transaction);
    assert.equal(modal.props.mode, "detail");
    (modal.props.onClose as () => void)();
    assert.ok(!elements(h.render()).some(e => e.type === h.module.TransactionModal));
    (buttons.find(e => e.props["aria-label"] === "Cetak ulang struk")!.props.onClick as () => void)();
    assert.equal(elements(h.render()).find(e => e.type === h.module.TransactionModal)!.props.mode, "print");
  }
  assert.equal(actionHarness("TransactionActions", { transaction, role: "STOCK_MANAGEMENT" }).render(), null);
});

test("detail displays saved values, WIB and placeholders without calculating totals", () => {
  const h = actionHarness("TransactionDetails", { transaction });
  const content = text(h.render());
  for (const value of ["Saved coffee x2", "AR-42", "17/09/2026", "00:05 WIB", "Tunai", "Rp43.000", "Rp44.000", "Qty 2", "HPP -", "Gross Profit -", "Pendapatan Bersih -"]) assert.ok(content.includes(value), value);
  assert.equal(elements(h.render()).filter(e => e.type === "button" || e.type === "input").length, 0);
});

test("report reprint guards rapid clicks, read and printer failures, marks COPY, and never changes row data", async () => {
  const printing = await import("../../../lib/printing/printer");
  const requests: { id: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const saved = structuredClone(transaction);
  let copies = 0;
  const h = actionHarness("TransactionModal", { transaction: saved, mode: "detail", onClose() {} }, {
    "@/lib/reports/action": { getReportReceiptAction: (id: unknown) => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) },
    "@/lib/printing/printer": { createReceiptPrintJob: (receipt: Parameters<typeof printing.createReceiptPrintJob>[0], adapter: undefined, copy: boolean) => {
      assert.equal(copy, true); copies++;
      return printing.createReceiptPrintJob(receipt, adapter, copy);
    } },
  });
  const click = () => (elements(h.render()).find(e => e.type === "button" && text(e) === "Cetak Ulang Struk")!.props.onClick as () => void)();
  click(); click(); assert.equal(requests.length, 1); assert.equal(requests[0].id, saved.orderId);
  assert.ok(elements(h.render()).filter(e => e.type === "button").every(e => e.props.disabled));
  let prevented = false;
  (h.render().props.onCancel as (event: unknown) => void)({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  requests[0].reject(new Error("secret transport")); await flush();
  assert.match(text(h.render()), /Periksa koneksi/); assert.equal(copies, 0);
  click(); requests[1].resolve({ success: false, error: "Struk tidak tersedia" }); await flush();
  assert.match(text(h.render()), /Struk tidak tersedia/); assert.equal(copies, 0);
  click(); requests[2].resolve({ success: true, receipt: {
    orderNumber: "AR-42", cashier: "Saved cashier", orderType: "DINE_IN", createdAt: saved.paidAt, paidAt: saved.paidAt,
    total: 44000, items: [{ name: "Saved coffee", quantity: 2, unitPrice: 22000, lineTotal: 44000 }],
    payment: { method: "CASH", amount: 44000, cashReceived: 50000, changeAmount: 6000, edcReference: null, succeededAt: saved.paidAt },
  } }); await flush();
  assert.equal(copies, 1);
  assert.match(text(h.render()), /Printer belum dikonfigurasi.*Pembayaran tetap berhasil/);
  assert.doesNotMatch(text(h.render()), /secret transport/);
  assert.deepEqual(saved, transaction);
});

test("report receipt action authenticates each call, ignores client actors, and sanitizes read failures", async () => {
  const redirect = new Error("redirect");
  let role: string | null = "ADMIN";
  let reads = 0;
  let fail = false;
  const { getReportReceiptAction: action } = load("../../../lib/reports/action.ts", {
    "next/navigation": { unstable_rethrow(e: unknown) { if (e === redirect) throw e; } },
    "../auth/authorization": { requireReportReader: async () => {
      if (!role || role === "STOCK_MANAGEMENT") throw redirect;
      return { id: "fresh", role };
    } },
    "../orders/receipt": { getReportReceipt: async (_db: unknown, actor: unknown, id: string) => {
      assert.deepEqual(actor, { id: "fresh", role }); assert.equal(id, "saved-order"); reads++;
      if (fail) throw new Error("database credential secret");
      return { orderNumber: "AR-42" };
    } },
    "../db": { prisma: {} }, "./domain": { ReportError }, "./service": {},
  });
  for (role of ["ADMIN", "CASHIER", "FINANCE"]) assert.equal((await action("saved-order")).success, true);
  assert.equal(reads, 3);
  assert.equal((await action({ orderId: "saved-order", actor: { role: "ADMIN" } })).success, false);
  assert.equal(reads, 3);
  for (role of ["STOCK_MANAGEMENT", null]) await assert.rejects(action("saved-order"), e => e === redirect);
  assert.equal(reads, 3);
  role = "ADMIN"; fail = true;
  const result = await action("saved-order");
  assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /secret|credential/);
});

test("report guard reloads the server user for every request and denies stock, inactive and anonymous sessions", async () => {
  let user: { id: string; role: string } | null = null;
  let reads = 0;
  const { requireReportReader: guard } = load("../../../lib/auth/authorization.ts", {
    "server-only": {}, "next/navigation": { redirect(path: string) { throw new Error(path); } },
    "./current-user": { getCurrentUser: async () => { reads++; return user; } },
  });
  for (const role of ["ADMIN", "CASHIER", "FINANCE"]) { user = { id: "fresh", role }; assert.equal(await guard(), user); }
  user = { id: "fresh", role: "STOCK_MANAGEMENT" }; await assert.rejects(guard());
  user = null; await assert.rejects(guard(), /login/); // current-user filters active:true
  assert.equal(reads, 5);
});

test("report print completion is terminal even for stale handlers and in-flight duplicate clicks", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  let prints = 0;
  const h = actionHarness("TransactionModal", { transaction, mode: "print", onClose() {} }, {
    "@/lib/reports/action": { getReportReceiptAction: async () => { reads++; return { success: true, receipt: {} }; } },
    "@/lib/printing/printer": { createReceiptPrintJob: () => ({ print: async () => { prints++; await pending; return { status: "succeeded" }; } }) },
  });
  const click = elements(h.render()).find(e => e.type === "button" && text(e) === "Cetak Ulang Struk")!.props.onClick as () => void;
  click(); click(); await flush();
  assert.equal(reads, 1); assert.equal(prints, 1);
  assert.match(text(h.render()), /Mencetak struk/);
  click(); assert.equal(reads, 1);
  finish(); await flush();
  assert.match(text(h.render()), /Permintaan cetak berhasil/);
  click(); await flush(); assert.equal(reads, 1); assert.equal(prints, 1);
});
