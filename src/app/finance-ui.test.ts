import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
type Element = { type: unknown; props: Record<string, unknown> };
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
// Compile real components with isolated boundary mocks; no app/database writes.
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const code = ts.transpileModule(source(file), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, (...args: never[]) => unknown> = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected component dependency: ${id}`);
  }, ...globals });
  return exports;
}

test("Finance dashboard authorizes before reads and displays server totals, empty and failure states", async () => {
  let user: { role: string } | null = null, reads = 0;
  const guards = load("../lib/auth/authorization.ts", {
    "server-only": {}, "./current-user": { getCurrentUser: async () => user },
    "next/navigation": { redirect(path: string) { throw new Error(`redirect ${path}`); } },
  });
  let result: unknown = { success: true, report: { paidSales: 1250000, paidOrderCount: 47, cashTotal: 350000, edcTotal: 400000, qrisTotal: 500000, transactions: [] } };
  const dashboard = load("./finance-dashboard.tsx", {
    "next/link": { default: "a" }, "@/lib/auth/authorization": guards,
    "@/lib/reports/domain": { jakartaBusinessDate: () => "2026-09-29" },
    "@/lib/reports/action": { getDailyReportAction: async (date: string) => { reads++; assert.equal(date, "2026-09-29"); return result; } },
  });
  for (const role of [null, "ADMIN", "CASHIER", "STOCK_MANAGEMENT"]) {
    user = role ? { role } : null;
    await assert.rejects(async () => dashboard.FinanceDashboard(), /redirect/);
    assert.equal(reads, 0);
  }
  user = { role: "FINANCE" };
  const tree = await dashboard.FinanceDashboard();
  for (const value of ["Laporan Hari Ini", "29 September 2026", "Total Penjualan", "Rp1.250.000", "47", "transaksi", "Tunai", "Rp350.000", "BCA EDC", "Rp400.000", "QRIS", "Rp500.000"]) assert.ok(text(tree).includes(value), value);
  assert.equal(reads, 1);
  assert.ok(elements(tree).some(e => e.props.href === "/admin/reports"));
  result = { success: false, error: "Laporan belum dapat dimuat." };
  const failed = await dashboard.FinanceDashboard();
  assert.match(text(failed), /Coba lagi/);
  assert.doesNotMatch(text(failed), /Rp|47|0 transaksi/);
  assert.ok(elements(failed).some(e => e.props.role === "alert"));
  result = { success: true, report: { paidSales: 0, paidOrderCount: 0, cashTotal: 0, edcTotal: 0, qrisTotal: 0 } };
  assert.match(text(await dashboard.FinanceDashboard()), /Belum ada transaksi lunas hari ini/);
});

test("Finance navigation contains only Dashboard, Laporan Harian and secure logout", async () => {
  let loggedOut = false;
  const nav = load("./finance-navigation.tsx", {
    "next/link": { default: "a" },
    "@/lib/auth/actions": { logoutAction: async () => { loggedOut = true; } },
    "next/navigation": { redirect(path: string) { assert.equal(loggedOut, true); assert.equal(path, "/login"); } },
  });
  const render = nav.FinanceNavigation as unknown as (props: { current: string }) => unknown;
  for (const current of ["dashboard", "report"]) {
    const tree = render({ current });
    assert.deepEqual(elements(tree).filter(e => e.props.href).map(e => e.props.href), ["/", "/admin/reports"]);
    assert.match(text(tree), /Dashboard.*Laporan Harian.*Keluar/);
    assert.doesNotMatch(text(tree), /POS|Stock|Resep|Recipe|Access|Admin|Supplier/);
    assert.equal(elements(tree).filter(e => e.props["aria-current"] === "page").length, 1);
    await (elements(tree).find(e => e.type === "form")!.props.action as () => Promise<void>)();
  }
});

test("inactive Finance session is rejected before dashboard report reads", async () => {
  let reads = 0;
  const current = load("../lib/auth/current-user.ts", {
    "server-only": {}, "./session": { getSessionIdentity: async () => ({ userId: "inactive-finance" }) },
    "./credentials": { safeUserSelect: { id: true, role: true } },
    "@/lib/db": { prisma: { user: { findFirst: async (query: { where: { active: boolean; id: string } }) => {
      assert.equal(query.where.active, true); assert.equal(query.where.id, "inactive-finance"); return null;
    } } } },
  });
  const guards = load("../lib/auth/authorization.ts", {
    "server-only": {}, "./current-user": current,
    "next/navigation": { redirect(path: string) { throw new Error(`redirect ${path}`); } },
  });
  const dashboard = load("./finance-dashboard.tsx", {
    "next/link": {}, "@/lib/auth/authorization": guards,
    "@/lib/reports/domain": { jakartaBusinessDate() { throw new Error("must authorize first"); } },
    "@/lib/reports/action": { getDailyReportAction() { reads++; } },
  });
  await assert.rejects(async () => dashboard.FinanceDashboard(), /redirect \/login/);
  assert.equal(reads, 0);
});
