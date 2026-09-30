/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as domain from "../../lib/finance/domain";
const require = createRequire(import.meta.url);
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join(" ") : node?.props ? text(node.props.children) : ["string", "number"].includes(typeof node) ? String(node) : "";
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(file: string, mocks: Record<string, unknown>, globals = {}) {
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  runInNewContext(code, { exports, ...globals, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected dependency ${id}`);
  } }); return exports;
}
function harness(file: string, component: string, props: any, actions: any, globals = {}) {
  const slots: any[] = [], effects: (() => void)[] = []; let index = 0;
  const react = {
    useState(initial: any) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial: any) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(work: () => any, deps: any[]) { const i = index++; if (!slots[i] || deps.some((d, n) => d !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = work(); }); } },
  };
  const loaded = load(file, { react, "next/link": { default: "a" }, "@/lib/finance/actions": actions,
    "@/lib/finance/domain": { ...domain, defaultPeriod: () => ({ type: "MONTH", value: "2026-09" }) },
    "@/lib/reports/domain": { jakartaBusinessDate: () => "2026-09-29" },
    "../report-panel": { control: "min-h-14", money: (n: number) => `Rp${n}`, PeriodControls: "PeriodControls" },
  }, globals);
  return { module: loaded, render() { index = 0; const tree = loaded[component](props); effects.splice(0).forEach(work => work()); return tree; } };
}
const summary = { paidSales: 99999, paidOrderCount: 3, cashTotal: 11111, edcTotal: 22222, qrisTotal: 33333, hpp: null, grossProfit: null, salesDeductions: 900, operatingExpenses: 777, netIncome: null };
const result = { success: true, data: { summary, inventory: { amount: null, missing: 2 }, breakdown: [{ key: "2026-09-01", ...summary }] } };

test("period controls, server-only display, immediate loading reset, stale responses and errors", async () => {
  const requests: { input: any; resolve: (r: any) => void; reject: (r: any) => void }[] = [];
  const h = harness("./report-panel.tsx", "FinanceReportPanel", { mode: "dashboard" }, { financeReportAction: (input: any) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) });
  assert.match(text(h.render()), /Memuat laporan/); assert.equal(requests[0].input.type, "MONTH"); assert.equal(requests[0].input.value, "2026-09");
  requests[0].resolve(result); await flush();
  let tree = h.render();
  // Deliberately inconsistent fixture: display server values without deriving totals.
  for (const expected of ["Rp99.999", "Rp11.111", "Rp22.222", "Rp33.333", "Rp777", "Saat ini", "Valuasi belum lengkap"]) assert.ok(text(tree).includes(expected), expected);
  assert.doesNotMatch(text(tree), /Rp0/);
  const controls = elements(tree).find(e => e.type === h.module.PeriodControls);
  const selector = h.module.PeriodControls(controls.props);
  assert.match(text(selector), /Harian.*Bulanan.*Tahunan.*Lifetime/);
  elements(selector).find(e => e.type === "button" && text(e) === "Tahunan").props.onClick();
  tree = h.render(); assert.match(text(tree), /Memuat laporan/); assert.doesNotMatch(text(tree), /Rp/);
  elements(tree).find(e => e.type === h.module.PeriodControls).props.onChange({ type: "LIFETIME" });
  h.render(); requests[1].resolve(result); await flush(); assert.match(text(h.render()), /Memuat laporan/);
  requests[2].reject(new Error("secret")); await flush(); tree = h.render(); assert.match(text(tree), /Coba lagi/); assert.doesNotMatch(text(tree), /Rp|secret/);
  elements(tree).find(e => e.type === "button" && text(e) === "Coba lagi").props.onClick(); h.render();
  requests[3].resolve({ ...result, data: { ...result.data, summary: { ...summary, paidSales: 0, paidOrderCount: 0, operatingExpenses: 0 } } });
  await flush(); assert.match(text(h.render()), /Belum ada transaksi atau pengeluaran/);
  assert.equal(elements(h.module.PeriodControls({ period: { type: "LIFETIME" }, onChange() {} })).filter(e => e.type === "input").length, 0);
});

test("dashboard source pills filter only server sales series and payment breakdown", async () => {
  let calls = 0;
  const h = harness("./report-panel.tsx", "FinanceReportPanel", { mode: "dashboard" }, { financeReportAction: async () => { calls++; return result; } });
  h.render(); await flush();
  for (const [label, key, amount] of [["Tunai", "cashTotal", "Rp11.111"], ["BCA EDC", "edcTotal", "Rp22.222"], ["QRIS", "qrisTotal", "Rp33.333"], ["Semua", "ALL", "Rp99.999"]]) {
    elements(h.render()).find(e => e.type === "button" && text(e) === label).props.onClick();
    const tree = h.render();
    assert.match(text(tree), /Dashboard Keuangan.*Bulanan · September 2026/);
    for (const expected of ["Pendapatan Bersih", "Total Pemasukan", "Total Pengeluaran", "Saat ini", "Rp99.999", "Rp777", "Valuasi belum lengkap"]) assert.ok(text(tree).includes(expected), expected);
    const breakdown = elements(tree).find(e => e.props["aria-label"] === "Rincian pembayaran");
    assert.equal(elements(breakdown).filter(e => e.type === "dd").length, key === "ALL" ? 3 : 1);
    if (key !== "ALL") assert.ok(text(breakdown).includes(amount));
    const chart = elements(tree).find(e => e.type === h.module.FinanceTrend);
    assert.equal(chart.props.source, key);
    const chartTree = h.module.FinanceTrend(chart.props);
    assert.ok(text(chartTree).includes(amount));
    assert.ok(text(chartTree).includes("Rp777"));
    assert.equal(elements(chartTree).filter(e => e.type === "polyline").length, 2);
    assert.equal(elements(tree).filter(e => e.props["aria-pressed"] === true).length, 1);
    assert.doesNotMatch(text(tree), /Edit|Hapus/);
  }
  assert.equal(calls, 1);
  for (const type of ["DAY", "LIFETIME"]) {
    const chart = h.module.FinanceTrend({ rows: [], source: "ALL", period: { type } });
    assert.match(text(chart), /Tren tersedia pada periode Bulanan dan Tahunan/);
    assert.equal(elements(chart).filter(e => e.type === "svg").length, 0);
  }
});

test("yearly to monthly and monthly to daily links preserve the selected Jakarta period", async () => {
  for (const [mode, key, href] of [["yearly", "2026-09", "/finance/reports/monthly?month=2026-09"], ["monthly", "2026-09-01", "/admin/reports?date=2026-09-01"]]) {
    const h = harness("./report-panel.tsx", "FinanceReportPanel", { mode }, { financeReportAction: async () => ({ ...result, data: { ...result.data, breakdown: [{ ...summary, key }] } }) });
    h.render(); await flush(); const tree = h.render();
    assert.ok(elements(tree).some(e => e.props.href === href));
    assert.ok(elements(tree).some(e => String(e.props.className).includes("overflow-x-auto")));
    assert.equal(elements(tree).filter(e => e.type === "input" && e.props.type === "checkbox").length, 0);
  }
});

test("expense form rejects malformed money, prevents in-flight duplicates, retains exact retry and refreshes", async () => {
  const calls: any[] = [], pending: ((r: any) => void)[] = [], saved = new Map<string, string>();
  const h = harness("./expenses/expense-panel.tsx", "ExpensePanel", { actorId: "finance" }, {
    expenseListAction: async () => ({ success: true, data: { rows: [], hasMore: false } }),
    expenseSaveAction: (input: any) => { calls.push(input); return new Promise(resolve => pending.push(resolve)); },
  }, { navigator: { onLine: true }, crypto: { randomUUID }, sessionStorage: { getItem: (k: string) => saved.get(k), setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) },
    FormData: class { constructor(private values: any) {} get(k: string) { return this.values[k]; } } });
  h.render(); await flush();
  elements(h.render()).find(e => e.type === "button" && text(e) === "Tambah Pengeluaran").props.onClick();
  const submit = elements(h.render()).find(e => e.type === "form").props.onSubmit;
  const fields = { date: "2026-09-29", category: "Internet", description: "Internet", note: "" };
  for (const amount of ["0", "-1", "1.5", "25.000", "25,000", "1e3", "2147483648"]) submit({ preventDefault() {}, currentTarget: { ...fields, amount } });
  assert.equal(calls.length, 0);
  submit({ preventDefault() {}, currentTarget: { ...fields, amount: "25000" } });
  submit({ preventDefault() {}, currentTarget: { ...fields, amount: "25000" } });
  assert.equal(calls.length, 1); assert.equal(saved.size, 1);
  pending[0]({ success: false, retryable: true, error: "Connection lost" }); await flush();
  const tree = h.render(); assert.ok(elements(tree).some(e => e.type === "fieldset" && e.props.disabled));
  elements(tree).find(e => e.type === "button" && text(e) === "Ulangi permintaan yang sama").props.onClick();
  assert.deepEqual(calls[1], calls[0]);
  pending[1]({ success: true, data: { id: calls[0].id } }); await flush();
  assert.match(text(h.render()), /Pengeluaran tersimpan/); assert.equal(saved.size, 0);
  assert.match(text(h.render()), /Memuat pengeluaran/);
});

test("all finance actions freshly guard before service work and derive the actor on server", async () => {
  let role: string | null = null, calls = 0;
  const actor = { id: "server-identity", role: "FINANCE" };
  const denied = new Error("redirect");
  const actions = load("../../lib/finance/actions.ts", {
  "next/navigation": {
    unstable_rethrow(e: unknown) {
      if (e === denied) throw e;
    },
  },
  "../auth/authorization": {
    requireFinanceManager: async () => {
      if (!["FINANCE", "ADMIN"].includes(role!)) throw denied;
      return actor;
    },
    requireRole: async (required: string) => {
      assert.equal(required, "ADMIN");
      if (role !== "ADMIN") throw denied;
      return { ...actor, role: "ADMIN" };
    },
  },
  "../db": { prisma: {} },
  "./domain": domain,
  "./history-deletion": {
    deleteFinanceHistory: async (_db: unknown, authenticated: unknown) => {
      assert.equal((authenticated as { role: string }).role, "ADMIN");
      calls++;
      return {};
    },
  },
  "./service": Object.fromEntries(
    ["getFinanceReport", "getFinanceHistory", "listExpenses", "saveExpense"].map(name => [
      name,
      async (_db: unknown, authenticated: unknown) => {
        assert.equal(authenticated, actor);
        calls++;
        return {};
      },
    ]),
  ),
});
  const managerActions = [
  actions.financeReportAction,
  actions.financeHistoryAction,
  actions.expenseListAction,
  actions.expenseSaveAction,
];

for (role of [null, "INACTIVE", "CASHIER", "STOCK_MANAGEMENT"]) {
  for (const action of [...managerActions, actions.financeHistoryDeleteAction]) {
    await assert.rejects(
      action({ role: "ADMIN", actorId: "browser" }),
      /redirect/,
    );
  }
}

assert.equal(calls, 0);

role = "FINANCE";

for (const action of managerActions) {
  assert.equal((await action({})).success, true);
}

await assert.rejects(
  actions.financeHistoryDeleteAction({}),
  /redirect/,
);

role = "ADMIN";

for (const action of managerActions) {
  assert.equal((await action({})).success, true);
}

assert.equal(
  (await actions.financeHistoryDeleteAction({})).success,
  true,
);

assert.equal(calls, 9);
});

test("finance page/action guard reloads current user and rejects missing, revoked and restricted users", async () => {
  let user: { id: string; role: string } | null = null, reads = 0;
  const guards = load("../../lib/auth/authorization.ts", {
    "server-only": {}, "./current-user": { getCurrentUser: async () => { reads++; return user; } },
    "next/navigation": { redirect: (path: string) => { throw new Error(`redirect ${path}`); } },
  });
  for (const role of [null, "CASHIER", "STOCK_MANAGEMENT"]) {
    user = role ? { id: "current", role } : null;
    await assert.rejects(guards.requireFinanceManager(), /redirect/);
  }
  for (const role of ["FINANCE", "ADMIN"]) { user = { id: "current", role }; assert.equal(await guards.requireFinanceManager(), user); }
  user = null; // current-user returns null after account deactivation
  await assert.rejects(guards.requireFinanceManager(), /redirect \/login/);
  assert.equal(reads, 6);
});

 test("category section renders authoritative amounts, percentages and empty state", () => {
  const h = harness("./report-panel.tsx", "FinanceReportPanel", { mode: "dashboard" }, {});
  const tree = h.module.ExpenseCategories({ total: 777, rows: [{ category: "Internet", amount: 123, percentage: 42, start: 0, end: 42 }] });
  assert.match(text(tree), /Kategori Pengeluaran.*Rp777.*Internet.*Rp123.*42\s*%/);
  assert.equal(elements(tree).filter(e => e.props.role === "img").length, 1);
  assert.match(text(h.module.ExpenseCategories({ total: 0, rows: [] })), /Belum ada pengeluaran/);
 });

 test("history filters, bounded pagination, loading, failures and stale responses", async () => {
  const requests: any[] = [];
  const h = harness("./report-panel.tsx", "FinanceHistory", { period: { type: "MONTH", value: "2026-09" }, source: "qrisTotal" }, {
    financeHistoryAction: (period: any, filter: any) => new Promise((resolve, reject) => requests.push({ period, filter, resolve, reject })),
  });
  const click = (label: string) => elements(h.render()).find(e => e.type === "button" && text(e) === label).props.onClick();
  assert.match(text(h.render()), /Riwayat Transaksi.*Semua.*Pemasukan.*Pengeluaran.*Memuat riwayat/);
  assert.equal(requests[0].filter.method, "MIDTRANS_QRIS");
  const data = { rows: [{ id: "one", type: "INCOME", date: "2026-09-01T00:00:00Z", title: "Penjualan - 4 produk", description: "Pesanan: AROOM-123", badge: "QRIS", amount: 56369 }], page: 1, pageSize: 10, total: 21, pages: 3 };
  requests[0].resolve({ success: true, data }); await flush();
  assert.match(text(h.render()), /Penjualan - 4 produk.*\+\s*Rp56.369.*AROOM-123.*1\s*–\s*10\s+dari\s+21/);
  assert.doesNotMatch(text(h.render()), /Edit|Hapus|Void|Admin/);
  click("Berikutnya"); assert.match(text(h.render()), /Memuat riwayat/); assert.equal(requests[1].filter.page, 2);
  click("Pengeluaran"); h.render(); assert.equal(requests[2].filter.type, "EXPENSE"); assert.equal(requests[2].filter.page, 1);
  requests[1].resolve({ success: true, data }); await flush(); assert.match(text(h.render()), /Memuat riwayat/);
  requests[2].resolve({ success: true, data: { ...data, rows: [], total: 0, pages: 1 } }); await flush();
  assert.match(text(h.render()), /Tidak ada transaksi/);
  click("Pemasukan"); h.render(); assert.equal(requests[3].filter.type, "INCOME");
  requests[3].reject(new Error("private")); await flush(); assert.match(text(h.render()), /Coba lagi/); assert.doesNotMatch(text(h.render()), /private|Rp56/);
  click("Coba lagi"); h.render(); assert.equal(requests.length, 5);
  elements(h.render()).find(e => e.type === "input").props.onChange({ target: { value: "AROOM" } }); h.render();
  assert.equal(requests[5].filter.search, "AROOM"); assert.equal(requests[5].filter.page, 1);
 });

 test("ADMIN history selection, confirmation and bulk delete while FINANCE stays read-only", async () => {
  const deleteCalls: any[] = [];
  let refreshed = 0;

  const data = {
    rows: [
      {
        id: "income-one",
        referenceId: "order-1",
        revision: 2,
        type: "INCOME",
        date: "2026-09-29T01:00:00.000Z",
        title: "Penjualan - Aroomsbrew",
        description: "Pesanan: AROOM-001",
        badge: "Tunai",
        amount: 25000,
      },
      {
        id: "expense-one",
        referenceId: "expense-1",
        revision: 3,
        type: "EXPENSE",
        date: "2026-09-29T02:00:00.000Z",
        title: "Internet",
        description: "Internet September",
        badge: "Operasional",
        amount: 300000,
      },
    ],
    page: 1,
    pageSize: 10,
    total: 2,
    pages: 1,
  };

  const actions = {
    financeHistoryAction: async () => ({
      success: true,
      data,
    }),
    financeHistoryDeleteAction: async (input: any) => {
      deleteCalls.push(input);
      return {
        success: true,
        data: { count: input.rows.length },
      };
    },
  };

  const admin = harness(
    "./report-panel.tsx",
    "FinanceHistory",
    {
      period: { type: "MONTH", value: "2026-09" },
      source: "ALL",
      canDelete: true,
      onDeleted: () => {
        refreshed++;
      },
    },
    actions,
    {
      navigator: { onLine: true },
      crypto: { randomUUID },
    },
  );

  admin.render();
  await flush();

  let tree = admin.render();

  assert.match(
    text(tree),
    /Pilih semua di halaman ini.*0\s+dipilih.*Hapus Terpilih/,
  );

  assert.equal(
    elements(tree).filter(
      e => e.type === "input" && e.props.type === "checkbox",
    ).length,
    3,
  );

  const selectAllLabel = elements(tree).find(
    e => e.type === "label" && text(e).includes("Pilih semua di halaman ini"),
  );

  const selectAll = elements(selectAllLabel).find(
    e => e.type === "input" && e.props.type === "checkbox",
  );

  selectAll.props.onChange({ target: { checked: true } });

  tree = admin.render();

  assert.match(text(tree), /2\s+dipilih/);

  elements(tree)
    .find(e => e.type === "button" && text(e) === "Hapus Terpilih")
    .props.onClick();

  tree = admin.render();

  assert.match(
  text(tree),
  /Hapus\s+2\s+transaksi dari laporan/,
  );

  assert.equal(deleteCalls.length, 0);

  elements(tree)
    .find(e => e.type === "button" && text(e) === "Batal")
    .props.onClick();

  tree = admin.render();

  assert.doesNotMatch(
  text(tree),
  /Hapus\s+2\s+transaksi dari laporan/,
  );
  assert.equal(deleteCalls.length, 0);

  elements(tree)
    .find(e => e.type === "button" && text(e) === "Hapus Terpilih")
    .props.onClick();

  tree = admin.render();

  elements(tree)
    .find(e => e.type === "button" && text(e) === "Hapus 2 Transaksi")
    .props.onClick();

  await flush();

  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].rows.length, 2);

  assert.deepEqual(
    deleteCalls[0].rows.map((row: any) => ({
      type: row.type,
      id: row.id,
      revision: row.revision,
    })),
    [
      {
        type: "INCOME",
        id: "order-1",
        revision: 2,
      },
      {
        type: "EXPENSE",
        id: "expense-1",
        revision: 3,
      },
    ],
  );

  assert.equal(refreshed, 1);

  const finance = harness(
    "./report-panel.tsx",
    "FinanceHistory",
    {
      period: { type: "MONTH", value: "2026-09" },
      source: "ALL",
      canDelete: false,
      onDeleted() {},
    },
    actions,
    {
      navigator: { onLine: true },
      crypto: { randomUUID },
    },
  );

  finance.render();
  await flush();

  const financeTree = finance.render();

  assert.doesNotMatch(
    text(financeTree),
    /Pilih semua di halaman ini|Hapus Terpilih/,
  );

  assert.equal(
    elements(financeTree).filter(
      e => e.type === "input" && e.props.type === "checkbox",
    ).length,
    0,
  );
});

 test("cashflow uses server net income with negative coordinates and gaps for unknown HPP", () => {
  const h = harness("./report-panel.tsx", "FinanceReportPanel", { mode: "dashboard" }, {});
  const tree = h.module.FinanceTrend({ rows: [{ ...summary, key: "2026-09-01", netIncome: -500 }, { ...summary, key: "2026-09-02", netIncome: null }, { ...summary, key: "2026-09-03", netIncome: 100 }], source: "ALL", period: { type: "MONTH" } });
  assert.match(text(tree), /Tren Cashflow.*Pendapatan Bersih/);
  assert.equal(elements(tree).filter(e => e.type === "line" && e.props.stroke === "#6878b7").length, 0);
  for (const circle of elements(tree).filter(e => e.type === "circle")) assert.ok(circle.props.cy >= 40 && circle.props.cy <= 222);
 });
