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

test("Admin home links Finance and preserves existing destinations in order", async () => {
  const page = load("./admin/page.tsx", {
    "next/link": { default: "a" },
    "@/lib/auth/authorization": { requireRole: async (role: string) => { assert.equal(role, "ADMIN"); return { name: "Admin" }; } },
  });
  const links = elements(await page.default()).filter(e => e.props.href);
  assert.deepEqual(links.map(e => [text(e), e.props.href]), [
    ["Access Management", "/admin/users"], ["Stock Management", "/inventory"],
    ["Resep & HPP", "/recipes"], ["Dashboard Finance", "/finance"],
    ["Laporan harian", "/admin/reports"], ["Kembali ke register", "/"],
  ]);
});

test("Finance route and dashboard enforce fresh authorization before rendering report reads", async () => {
  let session: { userId: string } | null = null;
  let user: { id: string; role: string; active: boolean } | null = null;
  let financeReads = 0;
  const current = load("../lib/auth/current-user.ts", {
    "server-only": {}, "./session": { getSessionIdentity: async () => session },
    "./credentials": { safeUserSelect: { id: true, role: true } },
    "@/lib/db": { prisma: { user: { findFirst: async (query: { where: { active: boolean; id: string } }) => {
      assert.equal(query.where.active, true);
      assert.equal(query.where.id, session!.userId);
      return user?.active ? user : null;
    } } } },
  });
  const guards = load("../lib/auth/authorization.ts", {
    "server-only": {}, "./current-user": current,
    "next/navigation": { redirect(path: string) { throw new Error(`redirect ${path}`); } },
  });
  const panel = () => { financeReads++; return null; };
  const dashboard = load("./finance-dashboard.tsx", {
    "@/lib/auth/authorization": guards,
    "./finance/report-panel": { FinanceReportPanel: panel },
  });
  const page = load("./finance/page.tsx", {
    "@/lib/auth/authorization": guards, react: { Suspense: "Suspense" },
    "../finance-dashboard": dashboard,
    "../finance-navigation": { FinanceNavigation: "navigation" },
  });
  for (const role of ["ADMIN", "FINANCE", "CASHIER", "STOCK_MANAGEMENT", "anonymous", "inactive"]) {
    session = role === "anonymous" ? null : { userId: "current" };
    user = { id: "current", role: role === "inactive" ? "FINANCE" : role, active: role !== "inactive" };
    financeReads = 0;
    if (role === "ADMIN" || role === "FINANCE") {
      const tree = await page.default();
      assert.ok(elements(tree).some(e => e.type === dashboard.FinanceDashboard));
      assert.ok(elements(tree).some(e => e.type === "navigation" && e.props.current === "dashboard"));
      const report = elements(await dashboard.FinanceDashboard()).find(e => e.type === panel);
      assert.equal(report?.props.mode, "dashboard");
      (report!.type as () => void)();
      assert.equal(financeReads, 1);
    } else {
      const expected = role === "anonymous" || role === "inactive" ? /redirect \/login/ : /redirect \/$/;
      await assert.rejects(async () => page.default(), expected);
      await assert.rejects(async () => dashboard.FinanceDashboard(), expected);
      assert.equal(financeReads, 0);
    }
  }
});

test("Finance dashboard authorizes before exposing period reporting", async () => {
  let allowed = false;
  const dashboard = load("./finance-dashboard.tsx", {
    "@/lib/auth/authorization": { requireFinanceManager: async () => { if (!allowed) throw new Error("denied"); } },
    "./finance/report-panel": { FinanceReportPanel: "period-report" },
  });
  await assert.rejects(async () => dashboard.FinanceDashboard(), /denied/);
  allowed = true;
  assert.ok(elements(await dashboard.FinanceDashboard()).some(e => e.type === "period-report" && e.props.mode === "dashboard"));
});

test("Finance navigation contains only approved reports, expenses and secure logout", async () => {
  let loggedOut = false;
  const nav = load("./finance-navigation.tsx", {
    "next/link": { default: "a" },
    "@/lib/auth/actions": { logoutAction: async () => { loggedOut = true; } },
    "next/navigation": { redirect(path: string) { assert.equal(loggedOut, true); assert.equal(path, "/login"); } },
  });
  const render = nav.FinanceNavigation as unknown as (props: { current: string }) => unknown;
  for (const current of ["dashboard", "report", "monthly", "yearly", "expenses"]) {
    const tree = render({ current });
    assert.deepEqual(elements(tree).filter(e => e.props.href).map(e => e.props.href), ["/finance", "/admin/reports", "/finance/reports/monthly", "/finance/reports/yearly", "/finance/expenses"]);
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
    "./finance/report-panel": { FinanceReportPanel: "period-report" }, "@/lib/auth/authorization": guards,
    "@/lib/reports/domain": { jakartaBusinessDate() { throw new Error("must authorize first"); } },
    "@/lib/reports/action": { getDailyReportAction() { reads++; } },
  });
  await assert.rejects(async () => dashboard.FinanceDashboard(), /redirect \/login/);
  assert.equal(reads, 0);
});
