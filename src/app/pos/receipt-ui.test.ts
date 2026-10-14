import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ReceiptPanel, type Receipt } from "./receipt-panel";
import * as printing from "../../lib/printing/printer";
import * as receiptFormat from "../../lib/printing/receipt-format";
import * as cupLabelFormat from "../../lib/printing/cup-label-format";
import { FakePrinterAdapter } from "../../lib/printing/testing/fake-printer";

const receipt: Receipt = {
  orderNumber: "AR-000123", cashier: "Dani", orderType: "DINE_IN",
  createdAt: "2026-09-15T18:30:00.000Z", paidAt: "2026-09-15T18:31:00.000Z",
  total: 44000,
  items: [{ name: "Saved Latte", unitPrice: 22000, quantity: 2, lineTotal: 44000 }],
  payment: { method: "CASH", amount: 44000, cashReceived: 50000, changeAmount: 6000,
    edcReference: null, succeededAt: "2026-09-15T18:31:00.000Z" },
};
const render = (value = receipt) => renderToStaticMarkup(createElement(ReceiptPanel, { receipt: value, onClose() {} }));

test("renders saved items, server totals and receipt identity in Jakarta time", () => {
  const html = render();
  for (const value of ["AROOM Coffee Bar", "AR-000123", "Dani", "Dine-in", "Saved Latte", "2", "Rp22.000", "Rp44.000", "16 Sep 2026", "01.30 WIB"]) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, /Pajak|Biaya layanan/);
});

test("renders cash received and change including zero change", () => {
  assert.match(render(), /Tunai.*Uang diterima: Rp50.000.*Kembalian: Rp6.000/);
  assert.match(render({ ...receipt, payment: { ...receipt.payment, cashReceived: 44000, changeAmount: 0 } }), /Kembalian: Rp0/);
  assert.doesNotMatch(render(), /Referensi EDC/);
});

test("renders EDC payment and optional reference without cash fields", () => {
  const edc: Receipt = { ...receipt, orderType: "TAKEAWAY", payment: { ...receipt.payment, method: "BCA_EDC", cashReceived: null, changeAmount: null, edcReference: "EDC-42" } };
  assert.match(render(edc), /Takeaway.*BCA EDC.*Referensi EDC: EDC-42/);
  assert.doesNotMatch(render(edc), /Uang diterima|Kembalian/);
  assert.doesNotMatch(render({ ...edc, payment: { ...edc.payment, edcReference: null } }), /Referensi EDC/);
});

test("close button invokes the supplied callback", () => {
  let closed = 0;
  const tree = ReceiptPanel({ receipt, onClose: () => closed++ });
  function findButton(node: ReactNode): ReactElement<{ onClick: () => void; children?: ReactNode }> | undefined {
    if (Array.isArray(node)) return node.map(findButton).find(Boolean);
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<{ onClick: () => void; children?: ReactNode }>;
    return element.type === "button" ? element : findButton(element.props.children);
  }
  const button = findButton(tree);
  assert.ok(button);
  button.props.onClick();
  assert.equal(closed, 1);
});

type Element = { type: unknown; props: Record<string, unknown>; key?: string };
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

// Match the existing POS test approach: execute the real UI and print service
// with isolated hook storage, injecting only the printer boundary.
function printHarness(adapter?: printing.PrinterAdapter) {
  const slots: unknown[] = [];
  let cursor = 0;
  const require = createRequire(import.meta.url);
  const code = ts.transpileModule(readFileSync(new URL("./receipt-panel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: { ReceiptPanel?: (props: unknown) => unknown } = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id === "@/lib/printing/printer") return printing;
    if (id === "@/lib/printing/receipt-format") return receiptFormat;
    if (id === "@/lib/printing/cup-label-format") return cupLabelFormat;
    if (id === "react") return {
      useState(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], (value: unknown) => { slots[index] = value; }];
      },
      useRef(initial: unknown) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
    };
    throw new Error(`Unexpected receipt UI dependency: ${id}`);
  } });
  const input = structuredClone(receipt);
  const renderControls = () => {
    const panel = exports.ReceiptPanel!({ receipt: input, printerAdapter: adapter, onClose() {} });
    const controls = elements(panel).find(element => typeof element.type === "function")!;
    assert.equal(controls.key, input.orderNumber);
    cursor = 0;
    return (controls.type as (props: unknown) => unknown)(controls.props);
  };
  const button = () => elements(renderControls()).find(element => element.type === "button")!;
  return { input, render: renderControls, button, click: () => (button().props.onClick as () => void)() };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("print UI shows printing, blocks duplicate clicks, retries the snapshot, then reports success", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const adapter = new FakePrinterAdapter([() => pending]);
  const ui = printHarness(adapter);
  assert.equal(text(ui.button()), "Cetak Struk");
  assert.equal(ui.button().props.disabled, false);
  const click = ui.button().props.onClick as () => void;
  click(); click();
  assert.equal(adapter.attempts.length, 1);
  assert.equal(ui.button().props.disabled, true);
  assert.match(text(ui.render()), /Mencetak.*Sedang mencetak/);
  fail(new Error("secret transport error"));
  await flush();
  assert.match(text(ui.render()), /Coba Cetak Lagi.*Pembayaran tetap berhasil/);
  assert.ok(elements(ui.render()).some(element => element.props.role === "alert"));
  assert.doesNotMatch(text(ui.render()), /secret transport/);
  assert.equal(ui.button().props.disabled, false);
  ui.input.items[0].name = "Changed after failure";
  ui.input.total = 1;
  ui.click();
  await flush();
  assert.equal(adapter.attempts.length, 2);
  assert.strictEqual(adapter.attempts[0], adapter.attempts[1]);
  assert.doesNotMatch(adapter.attempts[1].text, /Changed after failure/);
  assert.match(text(ui.render()), /Permintaan cetak berhasil/);
  assert.equal(ui.button().props.disabled, true);
  // Even a stale handler cannot submit the successful job twice.
  click();
  await flush();
  assert.equal(adapter.attempts.length, 2);
});

test("application default exposes an honest, retryable unconfigured-printer error", async () => {
  const ui = printHarness();
  ui.click();
  await flush();
  assert.match(text(ui.render()), /Printer belum dikonfigurasi.*Pembayaran tetap berhasil/);
  assert.equal(text(ui.button()), "Coba Cetak Lagi");
  ui.click();
  await flush();
  assert.match(text(ui.render()), /Printer belum dikonfigurasi/);
  assert.doesNotMatch(text(ui.render()), /Permintaan cetak berhasil/);
});

test("reopening a receipt cannot bypass an in-flight print job", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const adapter = new FakePrinterAdapter([() => pending]);
  const original = printHarness(adapter);
  original.click();
  const reopened = printHarness(adapter);
  try {
    reopened.click();
    await flush();
    assert.equal(adapter.attempts.length, 1);
    assert.match(text(reopened.render()), /Printer sedang digunakan/);
    assert.equal(text(reopened.button()), "Coba Cetak Lagi");
  } finally { finish(); }
  await flush();
  assert.match(text(original.render()), /Permintaan cetak berhasil/);
  // Completion of the old job must not report success in the new panel.
  assert.doesNotMatch(text(reopened.render()), /Permintaan cetak berhasil/);
});

const beverageReceipt: Receipt = { ...receipt, customerName: "Sinta", items: [
  { ...receipt.items[0], notes: "For takeaway", cups: [
    { sugar: "LESS", ice: "NORMAL", cup: "REGULAR", notes: "Oat milk" },
    { sugar: "NO_SUGAR", ice: "NO_ICE", cup: "LARGE", notes: "For Sinta" },
  ] },
  { name: "Brownie", unitPrice: 0, quantity: 1, lineTotal: 0 },
] };

function dualPrintHarness(input: Receipt = beverageReceipt, options: {
  receiptAdapter?: printing.PrinterAdapter;
  labelAdapter?: printing.LabelPrinterAdapter;
  receiptSimulation?: () => printing.PrinterAdapter;
  labelSimulation?: () => printing.LabelPrinterAdapter;
  copy?: boolean;
} = {}) {
  const require = createRequire(import.meta.url);
  const slots = new Map<string, unknown[]>();
  let active: unknown[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: unknown) {
      const instance = active;
      const index = cursor++;
      if (!(index in instance)) instance[index] = typeof initial === "function" ? initial() : initial;
      return [instance[index], (value: unknown) => { instance[index] = value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in active)) active[index] = { current: initial };
      return active[index];
    },
  };
  const code = ts.transpileModule(readFileSync(new URL("./receipt-panel.tsx", import.meta.url), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports: { ReceiptPanel?: (props: unknown) => unknown } = {};
  runInNewContext(code, { exports, require: (id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id === "react") return hooks;
    if (id === "@/lib/printing/receipt-format") return receiptFormat;
    if (id === "@/lib/printing/cup-label-format") return cupLabelFormat;
    if (id === "@/lib/printing/printer") return { ...printing,
      createSimulatedReceiptAdapter: options.receiptSimulation ?? printing.createSimulatedReceiptAdapter,
      createSimulatedLabelAdapter: options.labelSimulation ?? printing.createSimulatedLabelAdapter,
    };
    throw new Error(`Unexpected dual print UI dependency: ${id}`);
  } });
  function expand(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((value, index) => expand(value, `${path}/${index}`));
    if (!node || typeof node !== "object" || !("props" in node)) return node;
    const element = node as Element;
    if (typeof element.type === "function") {
      const key = element.key ?? path;
      if (!slots.has(key)) slots.set(key, []);
      active = slots.get(key)!;
      cursor = 0;
      return expand(element.type(element.props), key);
    }
    return { ...element, props: { ...element.props, children: expand(element.props.children, `${path}/children`) } };
  }
  const render = () => expand({ type: exports.ReceiptPanel, props: {
    receipt: input, onClose() {}, printerAdapter: options.receiptAdapter,
    labelPrinterAdapter: options.labelAdapter, copy: options.copy,
  } }, "root");
  const button = (label: string) => elements(render()).find(element => element.type === "button" && text(element).trim() === label);
  return { render, button, click(label: string) {
    const found = button(label);
    assert.ok(found, label);
    (found.props.onClick as () => void)();
  } };
}

test("independent previews show saved customer, cup customizations and COPY without labeling food", () => {
  const ui = dualPrintHarness(beverageReceipt, { copy: true });
  const tree = ui.render();
  assert.match(text(tree), /Pelanggan: Sinta/);
  assert.match(text(tree), /Catatan: For takeaway/);
  const previews = elements(tree).filter(element => element.type === "pre");
  assert.equal(previews.length, 3);
  previews.forEach(preview => assert.match(text(preview), /^AROOM Coffee Bar\nCOPY\n/));
  assert.match(text(previews[1]), /Cup: 1\/2\nSugar: LESS\nIce: NORMAL\nSize: REGULAR/);
  assert.match(text(previews[2]), /Cup: 2\/2\nSugar: NO SUGAR\nIce: NO ICE\nSize: LARGE/);
  assert.doesNotMatch(text(previews[1]) + text(previews[2]), /Brownie/);
  const legacy = dualPrintHarness(receipt);
  assert.match(text(legacy.render()), /Tidak ada label cup tersimpan/);
  assert.equal(elements(legacy.render()).filter(element => element.type === "pre").length, 1);
});

test("receipt and cup simulation controls complete honestly, stay independent, and block duplicate taps", async () => {
  let receiptAttempts = 0;
  let labelAttempts = 0;
  const ui = dualPrintHarness(beverageReceipt, {
    receiptSimulation: () => printing.createSimulatedReceiptAdapter([() => { receiptAttempts++; }]),
    labelSimulation: () => printing.createSimulatedLabelAdapter([() => { labelAttempts++; }]),
  });
  const receiptClick = ui.button("Simulasikan Struk")!.props.onClick as () => void;
  receiptClick(); receiptClick();
  ui.click("Simulasikan Label Cup 1");
  await flush();
  assert.equal(receiptAttempts, 1);
  assert.equal(labelAttempts, 1);
  const content = text(ui.render());
  assert.match(content, /Simulasi struk selesai. Belum dicetak secara fisik/);
  assert.match(content, /Simulasi label cup\s+1\s+selesai. Belum dicetak secara fisik/);
  assert.doesNotMatch(content, /Permintaan cetak.*berhasil/);
  assert.equal(ui.button("Simulasikan Struk")!.props.disabled, true);
  assert.equal(ui.button("Simulasikan Label Cup 1")!.props.disabled, true);
  assert.equal(ui.button("Simulasikan Label Cup 2")!.props.disabled, false);
  assert.equal(ui.button("Cetak Struk")!.props.disabled, false);
  receiptClick();
  await flush();
  assert.equal(receiptAttempts, 1);
});

test("cup simulation failure retries only that cup and retains its preview snapshot", async () => {
  const input = structuredClone(beverageReceipt);
  const attempts = [0, 0];
  let created = 0;
  const ui = dualPrintHarness(input, { labelSimulation: () => {
    const index = created++;
    const attempt = () => { attempts[index]++; };
    return printing.createSimulatedLabelAdapter(index === 1 ? [() => {
      attempt(); throw new Error("private simulation diagnostics");
    }, attempt] : [attempt]);
  } });
  ui.click("Simulasikan Label Cup 1");
  await flush();
  ui.click("Simulasikan Label Cup 2");
  await flush();
  assert.deepEqual(attempts, [1, 1]);
  assert.match(text(ui.render()), /Coba Simulasi Label Cup 2 Lagi.*Simulasi label gagal/);
  assert.doesNotMatch(text(ui.render()), /private simulation/);
  input.items[0].name = "Changed after label failure";
  input.items[0].cups![1].notes = "Changed note";
  ui.click("Coba Simulasi Label Cup 2 Lagi");
  await flush();
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(ui.button("Simulasikan Label Cup 1")!.props.disabled, true);
  assert.equal(ui.button("Simulasikan Label Cup 2")!.props.disabled, true);
  const secondPreview = elements(ui.render()).find(element => element.props["aria-label"] === "Pratinjau label cup 2")!;
  assert.match(text(secondPreview), /Saved Latte[\s\S]*For Sinta/);
  assert.doesNotMatch(text(secondPreview), /Changed/);
  assert.doesNotMatch(text(ui.render()), /Permintaan cetak.*berhasil/);
});

test("pending receipt printing does not block cup simulation and receipt failure keeps cup outcome", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const adapter = new FakePrinterAdapter([() => pending]);
  const ui = dualPrintHarness(beverageReceipt, { receiptAdapter: adapter });
  ui.click("Cetak Struk");
  try {
    ui.click("Simulasikan Label Cup 1");
    await flush();
    assert.equal(adapter.attempts.length, 1);
    assert.equal(ui.button("Mencetak...")!.props.disabled, true);
    assert.match(text(ui.render()), /Simulasi label cup\s+1\s+selesai/);
  } finally { fail(new Error("printer disconnected")); }
  await flush();
  assert.match(text(ui.render()), /Coba Cetak Lagi.*Pembayaran tetap berhasil/);
  assert.equal(ui.button("Simulasikan Label Cup 1")!.props.disabled, true);
  assert.match(text(ui.render()), /Simulasi label cup\s+1\s+selesai. Belum dicetak secara fisik/);
});
