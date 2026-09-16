import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptPanel, type Receipt } from "./receipt-panel";

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
