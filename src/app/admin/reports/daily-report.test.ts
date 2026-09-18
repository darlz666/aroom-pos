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
  cashTotal: 22000, edcTotal: 33000, qrisTotal: 44000, shifts: [{
    id: "shift", status: "CLOSED", cashierName: "Cashier", openedAt: "2026-09-16T16:00:00.000Z",
    closedAt: "2026-09-17T18:00:00.000Z", openingCash: 100000, expectedCash: 180000,
    countedCash: 179000, variance: -1000,
  }] };
const initial = { success: true, report };

test("report action requires ADMIN before report reads, preserves redirects and sanitizes failures", async () => {
  let role = "CASHIER";
  let reads = 0;
  let authFailure: Error | null = null;
  let serviceFailure: Error | null = null;
  const redirect = new Error("redirect");
  const db = {};
  const { getDailyReportAction: action } = load("../../../lib/reports/action.ts", {
    "next/navigation": { unstable_rethrow: (e: unknown) => { if (e === redirect) throw e; } },
    "../auth/authorization": { requireRole: async (required: string) => {
      assert.equal(required, "ADMIN");
      if (authFailure) throw authFailure;
      if (role !== "ADMIN") throw redirect;
      return { id: "admin", role };
    } },
    "../db": { prisma: db }, "./domain": { ReportError },
    "./service": { getDailyReport: async (client: unknown, actor: unknown, date: unknown) => {
      reads++;
      assert.equal(client, db);
      assert.deepEqual(actor, { id: "admin", role: "ADMIN" });
      assert.equal(date, "2026-09-17");
      if (serviceFailure) throw serviceFailure;
      return report;
    } },
  });
  for (role of ["CASHIER", "ANONYMOUS"]) await assert.rejects(action("2026-09-17"), e => e === redirect);
  assert.equal(reads, 0);
  role = "ADMIN";
  assert.equal((await action("2026-09-17")).report, report);
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
  const auth = { requireRole: async (role: string) => {
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
