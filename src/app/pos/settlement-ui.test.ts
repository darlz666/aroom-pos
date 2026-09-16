import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file: string, mocks: Record<string, unknown>) {
  const exports: Record<string, (...args: any[]) => any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  runInNewContext(code, { exports, require: (id: string) => {
    if (id in mocks) return mocks[id];
    if (id === "react" || id === "react/jsx-runtime") return require(id);
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  return exports;
}
const settlement = {
  shiftId: "00000000-0000-4000-8000-000000000001", openedAt: "2026-09-15T18:30:00.000Z", closedAt: null,
  totalOrders: 9, paidOrders: 6, cancelledOrders: 2, grossSales: 99000, cashSales: 44000, edcSales: 55000, expectedCash: 144000,
};

test("settlement displays every server value, rupiah, Jakarta dates and open/closed states", () => {
  const { SettlementSummary } = load("./settlement-panel.tsx", { "@/lib/shifts/settlement-action": {} });
  const render = (value = settlement) => renderToStaticMarkup(createElement(SettlementSummary, { settlement: value }));
  const html = render();
  for (const value of ["16 Sep 2026", "01.30 WIB", "Belum ditutup", "Total pesanan", ">9<", ">6<", ">2<", "Rp99.000", "Rp44.000", "Rp55.000", "Rp144.000"]) assert.ok(html.includes(value), value);
  const closed = render({ ...settlement, closedAt: "2026-09-16T20:00:00.000Z" } as unknown as typeof settlement);
  assert.match(closed, /17 Sep 2026.*03.00 WIB/);
  assert.doesNotMatch(closed, /Belum ditutup|<button|<form|<input/);
  assert.match(render({ ...settlement, grossSales: 0, cashSales: 0, edcSales: 0, expectedCash: 0 }), /Rp0/);
});

test("server boundary authenticates, authorizes owner/admin, serializes dates and hides failures", async () => {
  let authenticated = false;
  let actor = { id: "owner", role: "CASHIER" };
  let owner: { cashierId: string } | null = { cashierId: "owner" };
  let reads = 0;
  let fails = false;
  const { getShiftSettlementAction: action } = load("../../lib/shifts/settlement-action.ts", {
    "../auth/authorization": { requireUser: async () => { if (!authenticated) throw new Error("login"); return actor; } },
    "../db": { prisma: { shift: { findUnique: async () => owner } } },
    "./settlement": { getShiftSettlement: async () => {
      reads++;
      if (fails) throw new Error("database secret");
      return { ...settlement, openedAt: new Date(settlement.openedAt), closedAt: null };
    } },
  });
  await assert.rejects(action(settlement.shiftId), /login/);
  authenticated = true;
  assert.equal((await action("invalid")).success, false);
  actor = { id: "other", role: "CASHIER" };
  assert.equal((await action(settlement.shiftId)).success, false);
  assert.equal(reads, 0);
  actor = { id: "owner", role: "CASHIER" };
  assert.deepEqual(JSON.parse(JSON.stringify((await action(settlement.shiftId)).settlement)), settlement);
  actor = { id: "admin", role: "ADMIN" };
  assert.equal((await action(settlement.shiftId)).success, true);
  owner = null;
  assert.equal((await action(settlement.shiftId)).success, false);
  owner = { cashierId: "owner" };
  fails = true;
  const result = await action(settlement.shiftId);
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /database secret/);
});

test("panel guards duplicate reads, discards late responses, clears old totals and permits retry", async () => {
  const slots: unknown[] = [];
  let index = 0;
  let calls = 0;
  let resolve: (value: unknown) => void = () => {};
  const { SettlementPanel } = load("./settlement-panel.tsx", {
    react: {
      useState: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: unknown) => { slots[i] = v; }]; },
      useRef: (initial: unknown) => { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    },
    "@/lib/shifts/settlement-action": { getShiftSettlementAction: () => { calls++; return new Promise(r => { resolve = r; }); } },
  });
  type Element = { type: unknown; props: { children?: unknown; onClick?: () => void; disabled?: boolean } };
  function elements(node: unknown): Element[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const el = node as Element;
    return [el, ...elements(el.props.children)];
  }
  const render = () => { index = 0; return elements(SettlementPanel({ shiftId: settlement.shiftId })); };
  const button = (label: string) => render().find(e => e.type === "button" && e.props.children === label)!;
  button("Lihat settlement").props.onClick!();
  button("Lihat settlement").props.onClick!();
  assert.equal(calls, 1);
  assert.equal(button("Muat ulang").props.disabled, true);
  button("Kembali ke POS").props.onClick!();
  resolve({ success: true, settlement });
  await new Promise(r => setImmediate(r));
  assert.equal(slots[2], null);
  button("Lihat settlement").props.onClick!();
  resolve({ success: true, settlement });
  await new Promise(r => setImmediate(r));
  assert.equal(slots[2], settlement);
  button("Muat ulang").props.onClick!();
  assert.equal(slots[2], null);
  resolve({ success: false, error: "Connection lost" });
  await new Promise(r => setImmediate(r));
  assert.ok(button("Coba lagi"));
  button("Coba lagi").props.onClick!();
  resolve({ success: true, settlement });
  await new Promise(r => setImmediate(r));
  assert.equal(slots[2], settlement);
  assert.equal(slots[3], null);
});
