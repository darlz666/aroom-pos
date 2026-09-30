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

test("Finance dashboard authorizes before exposing period reporting", async () => {
  let allowed = false;
  const dashboard = load("./finance-dashboard.tsx", {
    "@/lib/auth/authorization": { requireRole: async (role: string) => { assert.equal(role, "FINANCE"); if (!allowed) throw new Error("denied"); } },
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
    assert.deepEqual(elements(tree).filter(e => e.props.href).map(e => e.props.href), ["/", "/admin/reports", "/finance/reports/monthly", "/finance/reports/yearly", "/finance/expenses"]);
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
