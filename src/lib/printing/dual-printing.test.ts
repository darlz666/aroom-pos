import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCupLabels, type PrintCupLabel } from "./cup-label-format";
import { formatReceipt, type Receipt } from "./receipt-format";
import {
  createCupLabelPrintJob, createReceiptPrintJob, createSimulatedLabelAdapter,
  createSimulatedReceiptAdapter, type LabelPrinterAdapter,
} from "./printer";
import { FakePrinterAdapter } from "./testing/fake-printer";

const receipt: Receipt = {
  orderNumber: "AR-000123", cashier: "Dani", customerName: "Sinta", orderType: "TAKEAWAY",
  createdAt: "2026-09-15T18:30:00.000Z", paidAt: "2026-09-15T18:31:00.000Z", total: 79000,
  items: [
    { name: "Saved Latte", unitPrice: 22000, quantity: 2, lineTotal: 44000, cups: [
      { sugar: "LESS", ice: "NORMAL", cup: "REGULAR", notes: "Oat milk" },
      { sugar: "NO_SUGAR", ice: "NO_ICE", cup: "LARGE", notes: "For Sinta" },
    ] },
    { name: "Brownie", unitPrice: 15000, quantity: 1, lineTotal: 15000, notes: "Warm, please" },
    { name: "Saved Americano", unitPrice: 20000, quantity: 1, lineTotal: 20000, cups: [
      { sugar: "NORMAL", ice: "LESS", cup: "REGULAR", notes: "" },
    ] },
  ],
  payment: { method: "CASH", amount: 79000, cashReceived: 100000, changeAmount: 21000,
    edcReference: null, succeededAt: "2026-09-15T18:31:00.000Z" },
};

test("one label per saved beverage unit keeps individual customization and skips food", () => {
  const before = JSON.stringify(receipt);
  const labels = formatCupLabels(receipt);
  assert.equal(labels.length, 3);
  assert.deepEqual(labels.map(label => [label.cupNumber, label.totalCups]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(labels[0].text, [
    "AROOM Coffee Bar", "Pesanan: AR-000123", "Pelanggan: Sinta", "Saved Latte", "Cup: 1/3",
    "Sugar: LESS", "Ice: NORMAL", "Size: REGULAR", "Catatan: Oat milk", "",
  ].join("\n"));
  assert.match(labels[1].text, /Cup: 2\/3\nSugar: NO SUGAR\nIce: NO ICE\nSize: LARGE\nCatatan: For Sinta\n/);
  assert.match(labels[2].text, /Saved Americano\nCup: 3\/3\nSugar: NORMAL\nIce: LESS\nSize: REGULAR\n/);
  assert.doesNotMatch(labels.map(label => label.text).join(""), /Brownie|Rp|TOTAL|Catatan: $/m);
  assert.equal(JSON.stringify(receipt), before);
  assert.equal(Object.isFrozen(labels), true);
  assert.ok(labels.every(Object.isFrozen));
  assert.deepEqual(formatCupLabels(structuredClone(receipt)), labels);
});

test("historical items with no saved cups generate no guessed labels and retain receipt values", () => {
  const legacy: Receipt = { ...receipt, customerName: undefined,
    items: [{ name: "Coffee", quantity: 2, unitPrice: 22000, lineTotal: 44000 }] };
  assert.deepEqual(formatCupLabels(legacy), []);
  const text = formatReceipt(legacy).text;
  assert.match(text, /Pelanggan: -\n/);
  assert.match(text, /2 x Rp22.000\nJumlah: Rp44.000\n/);
  assert.match(text, /TOTAL: Rp79.000\n/); // Render saved total, never recalculate.
  assert.match(formatReceipt(receipt).text, /Pelanggan: Sinta\n/);
  assert.match(formatReceipt(receipt).text, /Catatan: Warm, please\n/);
});

test("cup copies are clearly marked and long fields/control characters remain logical text", () => {
  const copies = formatCupLabels(receipt, true);
  copies.forEach((label, index) => {
    assert.match(label.text, /^AROOM Coffee Bar\nCOPY\n/);
    assert.equal(label.text.replace("COPY\n", ""), formatCupLabels(receipt)[index].text);
  });
  const unsafe: Receipt = { ...receipt, customerName: "Si\x1b\x00nta\nTest",
    items: [{ ...receipt.items[0], name: "Cafe\u0301 " + "A".repeat(80), cups: [
      { sugar: "NORMAL", ice: "NORMAL", cup: "REGULAR", notes: "Line one\n\x1b\x00line two\t" + "N".repeat(100) },
    ] }] };
  const text = formatCupLabels(unsafe)[0].text;
  assert.match(text, /Pelanggan: Si nta Test\n/);
  assert.match(text, /Caf\u00e9\n/);
  assert.match(text, /Catatan: Line one line two/);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f]/);
  for (const line of text.trimEnd().split("\n")) assert.ok(Array.from(line).length <= 32, line);
  assert.ok(text.replaceAll("\n", "").includes("N".repeat(100)));
});

test("simulation has its own terminal outcome and never claims physically successful printing", async () => {
  let receiptAttempts = 0;
  let labelAttempts = 0;
  const receiptJob = createReceiptPrintJob(receipt, createSimulatedReceiptAdapter([() => { receiptAttempts++; }]));
  const labelJob = createCupLabelPrintJob(formatCupLabels(receipt)[0], createSimulatedLabelAdapter([() => { labelAttempts++; }]));
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.deepEqual(await receiptJob.print(), { status: "simulated" });
    assert.deepEqual(await labelJob.print(), { status: "simulated" });
  }
  assert.equal(receiptAttempts, 1);
  assert.equal(labelAttempts, 1);
  assert.equal((await createCupLabelPrintJob(formatCupLabels(receipt)[0]).print()).status, "failed");
});

test("receipt and label destinations run independently while duplicate label jobs stay busy", async () => {
  let finishReceipt!: () => void;
  let finishLabel!: () => void;
  const waitingReceipt = new Promise<void>(resolve => { finishReceipt = resolve; });
  const waitingLabel = new Promise<void>(resolve => { finishLabel = resolve; });
  const receiptPrinter = new FakePrinterAdapter([() => waitingReceipt]);
  const receiptJob = createReceiptPrintJob(receipt, receiptPrinter);
  const labels = formatCupLabels(receipt);
  let labelAttempts = 0;
  const adapter = createSimulatedLabelAdapter([() => { labelAttempts++; return waitingLabel; }, () => { labelAttempts++; }]);
  const firstLabel = createCupLabelPrintJob(labels[0], adapter);
  const otherLabel = createCupLabelPrintJob(labels[1], adapter);
  const runningReceipt = receiptJob.print();
  const runningLabel = firstLabel.print();
  try {
    assert.equal(labelAttempts, 1); // A pending receipt did not block this label.
    assert.equal((await firstLabel.print()).status, "busy");
    assert.equal((await otherLabel.print()).status, "busy");
    assert.equal((await receiptJob.print()).status, "busy");
  } finally {
    finishReceipt();
    finishLabel();
  }
  assert.equal((await runningReceipt).status, "succeeded");
  assert.equal((await runningLabel).status, "simulated");
  assert.equal(labelAttempts, 1); // No automatic queue of blocked work.
  assert.equal((await otherLabel.print()).status, "simulated");
  assert.equal(labelAttempts, 2);
});

test("a pending label cannot block receipt simulation", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const labelJob = createCupLabelPrintJob(formatCupLabels(receipt)[0], createSimulatedLabelAdapter([() => pending]));
  const runningLabel = labelJob.print();
  try {
    assert.deepEqual(await createReceiptPrintJob(receipt, createSimulatedReceiptAdapter()).print(), { status: "simulated" });
  } finally { finish(); }
  assert.equal((await runningLabel).status, "simulated");
});

test("retry only the failed cup with exact snapshot; other cups and payment remain complete", async () => {
  const before = JSON.stringify(receipt);
  const labels = formatCupLabels(receipt);
  const attempts: PrintCupLabel[] = [];
  let shouldFail = true;
  const printer: LabelPrinterAdapter = { mode: "physical", async print(label) {
    attempts.push(label);
    if (label.cupNumber === 2 && shouldFail) {
      shouldFail = false;
      throw new Error("private Bluetooth diagnostics");
    }
  } };
  const first = createCupLabelPrintJob(labels[0], printer);
  const mutableInput = { ...labels[1] };
  const second = createCupLabelPrintJob(mutableInput, printer);
  assert.equal((await first.print()).status, "succeeded");
  const failed = await second.print();
  assert.equal(failed.status, "failed");
  assert.ok("error" in failed);
  assert.match(failed.error, /Label gagal dicetak.*Pembayaran tetap berhasil/);
  assert.doesNotMatch(failed.error, /Bluetooth diagnostics/);
  mutableInput.text = "Changed preview";
  assert.equal((await second.print()).status, "succeeded");
  assert.equal((await first.print()).status, "succeeded");
  assert.deepEqual(attempts.map(label => label.cupNumber), [1, 2, 2]);
  assert.strictEqual(attempts[1], attempts[2]);
  assert.equal(attempts[2].text, labels[1].text);
  assert.equal(Object.isFrozen(attempts[2]), true);
  assert.equal(JSON.stringify(receipt), before);
});

test("controlled simulation errors are retryable without becoming physical outcomes", async () => {
  const adapter = createSimulatedLabelAdapter([() => { throw new Error("private details"); }]);
  const job = createCupLabelPrintJob(formatCupLabels(receipt)[0], adapter);
  const failed = await job.print();
  assert.equal(failed.status, "failed");
  assert.ok("error" in failed);
  assert.match(failed.error, /Simulasi label gagal.*Pembayaran tetap berhasil/);
  assert.doesNotMatch(failed.error, /private details/);
  assert.deepEqual(await job.print(), { status: "simulated" });
});
