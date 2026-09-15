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

test("POS authenticates before reads and gates the cart using server shift state", async () => {
  let authenticated = false;
  let reads = 0;
  let menuFails = false;
  let state: Record<string, unknown> = { success: true, state: "EMPTY" };
  const PosMenu = () => null;
  const categories = [{ id: "c", name: "Coffee", products: [] }];
  const page = load("./page.tsx", {
    "next/link": { default: "a" },
    "@/lib/auth/authorization": { requireUser: async () => {
      if (!authenticated) throw new Error("redirect login");
      return { name: "Operator", passwordHash: "secret-hash" };
    } },
    "@/lib/shifts/actions": { getActiveShiftAction: async () => state },
    "@/lib/db": { prisma: { category: { findMany: async (query: unknown) => {
      reads++;
      assert.deepEqual(JSON.parse(JSON.stringify(query)), {
        where: { active: true }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, products: { where: { active: true }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, price: true, available: true } } },
      });
      if (menuFails) throw new Error("secret-database");
      return categories;
    } } } },
    "./pos-menu": { PosMenu },
  });
  await assert.rejects(async () => page.default(), /redirect login/);
  assert.equal(reads, 0);
  authenticated = true;
  for (const blocked of [{ success: true, state: "EMPTY" }, { success: true, state: "OCCUPIED" }, { success: false }]) {
    state = blocked;
    const tree = await page.default();
    assert.ok(!elements(tree).some(e => e.type === PosMenu));
    assert.match(text(tree), /Kelola shift/);
  }
  assert.equal(reads, 0);
  for (const permitted of ["OWNED", "ADMIN_VIEW"]) {
    state = { success: true, state: permitted, shift: { id: "shift", ownerName: "Owner", openedAt: "2026-09-10T18:30:00Z", openingCash: "secret-cash" } };
    const tree = await page.default();
    const client = elements(tree).find(e => e.type === PosMenu)!;
    assert.deepEqual(Object.keys(client.props), ["categories"]);
    assert.equal(client.props.categories, categories);
    assert.match(text(tree), /11 Sep 2026.*01[.:]30/);
    assert.equal(text(tree).includes("Mode bantuan admin"), permitted === "ADMIN_VIEW");
    assert.doesNotMatch(JSON.stringify(tree), /secret-/);
  }
  menuFails = true;
  const failed = await page.default();
  assert.match(text(failed), /Menu belum dapat dimuat/);
  assert.ok(!elements(failed).some(e => e.type === PosMenu));
  assert.doesNotMatch(text(failed), /secret-/);
});

test("local cart supports filtering, repeated taps, quantity bounds, removal and order type", () => {
  const slots: unknown[] = [];
  let cursor = 0;
  const component = load("./pos-menu.tsx", {
    "@/lib/orders/actions": { createOrderAction: async () => { throw new Error("unused"); } },
    react: { useRef: (initial: unknown) => { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; }, useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
    } },
  });
  const props = { categories: [
    { id: "coffee", name: "Coffee", products: [{ id: "a", name: "Latte", price: 22000, available: true }, { id: "b", name: "Sold out", price: 20000, available: false }] },
    { id: "food", name: "Food", products: [{ id: "c", name: "Fries", price: 16000, available: true }] },
    { id: "empty", name: "Empty", products: [] },
  ] };
  const render = () => { cursor = 0; return component.PosMenu(props as never); };
  const button = (label: string) => elements(render()).find(e => e.type === "button" && (e.props["aria-label"] === label || text(e.props.children) === label))!;
  const click = (label: string) => (button(label).props.onClick as () => void)();
  assert.match(text(render()), /Keranjang masih kosong/);
  assert.equal(button("Buat Pesanan").props.disabled, true);
  assert.equal(button("Buat Pesanan").props.type, "button");
  assert.equal(typeof button("Buat Pesanan").props.onClick, "function");
  assert.equal(button("Tambah Sold out").props.disabled, true);
  click("Tambah Sold out");
  assert.match(text(render()), /Keranjang masih kosong/);
  const rapidAdd = button("Tambah Latte").props.onClick as () => void;
  rapidAdd(); rapidAdd(); rapidAdd();
  assert.match(text(render()), /Rp66.000/);
  click("Food");
  assert.equal(button("Tambah Latte"), undefined);
  assert.match(text(render()), /Rp66.000/);
  click("Tambah Fries");
  assert.match(text(render()), /Rp82.000/);
  assert.equal(button("Buat Pesanan").props.disabled, false);
  click("TAKEAWAY");
  assert.equal(button("TAKEAWAY").props["aria-pressed"], true);
  assert.equal(button("DINE IN").props["aria-pressed"], false);
  click("Kurangi Latte");
  assert.match(text(render()), /Rp60.000/);
  click("Kurangi Latte");
  assert.equal(button("Kurangi Latte").props.disabled, true);
  for (let i = 0; i < 110; i++) click("Tambah jumlah Latte");
  assert.equal(button("Tambah jumlah Latte").props.disabled, true);
  assert.match(text(render()), /Rp2.194.000/);
  click("Hapus Latte"); click("Hapus Fries");
  assert.match(text(render()), /Keranjang masih kosong/);
  assert.match(text(render()), /Rp0/);
  click("Empty");
  assert.match(text(render()), /Belum ada produk/);
  slots.length = 0;
  assert.equal(button("DINE IN").props["aria-pressed"], true);
  assert.match(text(render()), /Keranjang masih kosong/);
});

test("POS uses only create action and has no browser persistence", () => {
  const client = source("./pos-menu.tsx");
  assert.doesNotMatch(client + source("./page.tsx"), /editOrderAction|cancelOrderAction|localStorage|sessionStorage|indexedDB|fetch\(|createOrder\(/);
  assert.match(client, /lg:grid-cols-/);
  assert.match(client, /min-h-12/);
});



function creationHarness() {
  const slots: unknown[] = [];
  let cursor = 0;
  let uuids = 0;
  const requests: unknown[] = [];
  let resolve!: (result: unknown) => void;
  let reject!: (error: unknown) => void;
  const component = load("./pos-menu.tsx", {
    react: {
      useState: (initial: unknown) => {
        const i = cursor++;
        if (!(i in slots)) slots[i] = initial;
        return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
      },
      useRef: (initial: unknown) => {
        const i = cursor++;
        if (!(i in slots)) slots[i] = { current: initial };
        return slots[i];
      },
    },
    "@/lib/orders/actions": { createOrderAction: (input: unknown) => {
      requests.push(JSON.parse(JSON.stringify(input)));
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    } },
  }, { crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, "0")}` } });
  const props = { categories: [{ id: "c", name: "Coffee", products: [
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Latte", price: 22000, available: true },
  ] }] };
  const render = () => { cursor = 0; return component.PosMenu(props as never); };
  const button = (label: string) => elements(render()).find(e => e.type === "button" && (e.props["aria-label"] === label || text(e.props.children) === label))!;
  const click = (label: string) => (button(label).props.onClick as () => Promise<void>)();
  return { render, button, click, requests, uuids: () => uuids,
    resolve: (value: unknown) => resolve(value), reject: () => reject(new Error("private transport details")) };
}
const saved = (replayed = false) => ({ success: true, order: { orderNumber: "AR-123456", total: 31000, status: "UNPAID", replayed } });

test("create sends only allowed fields, guards double clicks, freezes controls and acknowledges authoritative success", async () => {
  const h = creationHarness();
  assert.equal(h.button("Buat Pesanan").props.disabled, true);
  await h.click("Buat Pesanan");
  assert.equal(h.requests.length, 0);
  h.click("Tambah Latte");
  assert.equal(h.button("Buat Pesanan").props.disabled, false);
  const submit = h.button("Buat Pesanan").props.onClick as () => Promise<void>;
  const pending = submit();
  await submit();
  assert.equal(h.requests.length, 1);
  assert.equal(h.uuids(), 1);
  assert.deepEqual(h.requests[0], { createIdempotencyKey: "00000000-0000-4000-8000-000000000001", orderType: "DINE_IN", items: [{ productId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", quantity: 1 }] });
  assert.doesNotMatch(JSON.stringify(h.requests), /price|productName|total|shiftId|cashierId|role|actorId|status|revision|fingerprint|Latte/);
  for (const label of ["Tambah Latte", "TAKEAWAY", "DINE IN", "Hapus Latte", "Tambah jumlah Latte", "Kurangi Latte", "Menyimpan..."]) assert.equal(h.button(label).props.disabled, true);
  h.click("Tambah Latte"); h.click("Hapus Latte"); h.click("TAKEAWAY");
  h.resolve(saved()); await pending;
  assert.match(text(h.render()), /Pesanan berhasil dibuat.*AR-123456.*Rp31.000.*UNPAID/);
  assert.match(text(h.render()), /Keranjang masih kosong/);
  assert.equal(h.button("DINE IN").props["aria-pressed"], true);
  assert.equal(h.requests.length, 1);
  h.click("Pesanan Baru"); h.click("Tambah Latte"); h.click("TAKEAWAY");
  const next = h.click("Buat Pesanan");
  assert.equal(h.uuids(), 2);
  assert.equal((h.requests[1] as { orderType: string }).orderType, "TAKEAWAY");
  h.resolve(saved(true)); await next;
  assert.match(text(h.render()), /ditemukan kembali dari permintaan sebelumnya/);
  assert.equal(h.button("DINE IN").props["aria-pressed"], true);
  assert.equal(h.requests.length, 2);
});

test("CREATE_FAILED and transport loss retain exact snapshot until recovered, even after retry permission failure", async () => {
  for (const transport of [false, true]) {
    const h = creationHarness();
    h.click("Tambah Latte"); h.click("Tambah jumlah Latte"); h.click("TAKEAWAY");
    let pending = h.click("Buat Pesanan");
    if (transport) h.reject(); else h.resolve({ success: false, code: "CREATE_FAILED", error: "safe" });
    await pending;
    assert.match(text(h.render()), /belum dapat dipastikan.*Jangan meninggalkan/);
    assert.doesNotMatch(text(h.render()), /private transport/);
    for (const label of ["Tambah Latte", "Hapus Latte", "Tambah jumlah Latte", "Kurangi Latte", "DINE IN", "TAKEAWAY"]) {
      assert.equal(h.button(label).props.disabled, true);
      h.click(label);
    }
    pending = h.click("Coba Lagi");
    h.resolve({ success: false, code: "FORBIDDEN", error: "Izin ditolak." }); await pending;
    assert.match(text(h.render()), /Izin ditolak/);
    assert.equal(h.button("Hapus Latte").props.disabled, true);
    pending = h.click("Coba Lagi");
    assert.deepEqual(h.requests[1], h.requests[0]);
    assert.deepEqual(h.requests[2], h.requests[0]);
    assert.equal(h.uuids(), 1);
    h.resolve(saved(true)); await pending;
    assert.match(text(h.render()), /ditemukan kembali/);
    assert.equal(h.requests.length, 3);
  }
});

test("definite validation errors allow review and rotate the key only after draft edits", async () => {
  for (const code of ["PRODUCT_UNAVAILABLE", "PRODUCT_NOT_FOUND", "INVALID_QUANTITY", "TOO_MANY_ITEMS", "MONEY_OVERFLOW", "NO_ACTIVE_SHIFT", "FORBIDDEN", "INVALID_INPUT", "INVALID_IDEMPOTENCY_KEY"]) {
    const h = creationHarness(); h.click("Tambah Latte");
    let pending = h.click("Buat Pesanan");
    h.resolve({ success: false, code, error: "Pesan aman dari server." }); await pending;
    assert.match(text(h.render()), /Pesan aman dari server/);
    assert.equal(h.button("Hapus Latte").props.disabled, false);
    pending = h.click("Buat Pesanan");
    assert.deepEqual(h.requests[1], h.requests[0]);
    h.resolve({ success: false, code, error: "Pesan aman dari server." }); await pending;
    h.click("Tambah jumlah Latte");
    assert.doesNotMatch(text(h.render()), /Pesan aman dari server/);
    pending = h.click("Buat Pesanan");
    assert.equal(h.uuids(), 2);
    assert.equal((h.requests[2] as { items: { quantity: number }[] }).items[0].quantity, 2);
    h.resolve(saved()); await pending;
  }
});

test("idempotency conflict blocks mutation and further creation without a replacement key", async () => {
  const h = creationHarness(); h.click("Tambah Latte");
  const pending = h.click("Buat Pesanan");
  h.resolve({ success: false, code: "IDEMPOTENCY_CONFLICT", error: "Identitas permintaan sudah digunakan." }); await pending;
  assert.match(text(h.render()), /Identitas permintaan.*Tinjau pesanan.*Jangan membuat permintaan pengganti/);
  assert.equal(h.button("Hapus Latte").props.disabled, true);
  assert.equal(h.button("Buat Pesanan").props.disabled, true);
  await h.click("Buat Pesanan");
  assert.equal(h.requests.length, 1);
  assert.equal(h.uuids(), 1);
});
