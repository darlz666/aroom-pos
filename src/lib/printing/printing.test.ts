import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReceipt, type Receipt } from "./receipt-format";
import { createReceiptPrintJob } from "./printer";
import { FakePrinterAdapter } from "./testing/fake-printer";

const receipt: Receipt = {
  orderNumber: "AR-000123", cashier: "Dani", orderType: "DINE_IN",
  createdAt: "2026-09-15T18:30:00.000Z", paidAt: "2026-09-15T18:31:00.000Z", total: 44000,
  items: [{ name: "Saved Latte", unitPrice: 22000, quantity: 2, lineTotal: 44000 }],
  payment: { method: "CASH", amount: 44000, cashReceived: 50000, changeAmount: 6000,
    edcReference: null, succeededAt: "2026-09-15T18:31:00.000Z" },
};

test("deterministic 58 mm CASH receipt uses Jakarta time and saved rupiah values", () => {
  const output = formatReceipt(receipt);
  assert.deepEqual(output, { paperWidthMm: 58, columns: 32, text: [
    "AROOM Coffee Bar",
    "Pesanan: AR-000123",
    "16/09/2026 01:30 WIB",
    "Kasir: Dani",
    "Dine-in",
    "--------------------------------",
    "Saved Latte",
    "2 x Rp22.000",
    "Jumlah: Rp44.000",
    "--------------------------------",
    "TOTAL: Rp44.000",
    "Pembayaran: Tunai",
    "Uang diterima: Rp50.000",
    "Kembalian: Rp6.000",
    "",
  ].join("\n") });
  assert.deepEqual(formatReceipt(structuredClone(receipt)), output);
  assert.doesNotMatch(output.text, /tax|pajak|service|layanan|COPY|REPRINT/i);
  assert.equal(Object.isFrozen(output), true);
  assert.match(formatReceipt({ ...receipt, payment: { ...receipt.payment, changeAmount: 0 } }).text, /Kembalian: Rp0\n/);
  // Presentation must preserve server values, even if a test fixture is inconsistent.
  const savedValues = formatReceipt({ ...receipt, total: 12345,
    items: [{ ...receipt.items[0], lineTotal: 123 }],
    payment: { ...receipt.payment, changeAmount: 456 } });
  assert.match(savedValues.text, /Jumlah: Rp123\n/);
  assert.match(savedValues.text, /TOTAL: Rp12.345\n/);
  assert.match(savedValues.text, /Kembalian: Rp456\n/);
});

test("BCA EDC has optional reference, Takeaway and no cash fields", () => {
  const edc: Receipt = { ...receipt, orderType: "TAKEAWAY", payment: {
    ...receipt.payment, method: "BCA_EDC", cashReceived: null, changeAmount: null, edcReference: "EDC-42",
  } };
  const output = formatReceipt(edc).text;
  assert.match(output, /Takeaway\n/);
  assert.match(output, /Pembayaran: BCA EDC\nReferensi EDC: EDC-42\n/);
  assert.doesNotMatch(output, /Uang diterima|Kembalian|tax|pajak|service|layanan/i);
  assert.doesNotMatch(formatReceipt({ ...edc, payment: { ...edc.payment, edcReference: null } }).text, /Referensi/);
});

test("copy is explicitly marked and QRIS formatting adds no cash or EDC details", () => {
  assert.match(formatReceipt(receipt, true).text, /^AROOM Coffee Bar\nCOPY\n/);
  assert.equal(formatReceipt(receipt, true).text.replace("COPY\n", ""), formatReceipt(receipt).text);
  const qris = formatReceipt({ ...receipt, payment: { ...receipt.payment, method: "MIDTRANS_QRIS" } }).text;
  assert.match(qris, /Pembayaran: QRIS\n/);
  assert.doesNotMatch(qris, /Uang diterima|Kembalian|Referensi/);
});

test("long names, large amounts and references wrap without truncation or control characters", () => {
  const longName = "Kopi Susu " + "é".repeat(70);
  const output = formatReceipt({ ...receipt, cashier: "Cashier " + "A".repeat(60),
    items: [{ name: longName, quantity: 99, unitPrice: 21474836, lineTotal: 2126008764 }],
    total: 2126008764, payment: { ...receipt.payment, method: "BCA_EDC", edcReference: "REF".repeat(30) },
  });
  for (const line of output.text.trimEnd().split("\n")) assert.ok(Array.from(line).length <= 32, line);
  assert.ok(output.text.replaceAll("\n", "").includes("é".repeat(70)));
  assert.ok(output.text.replaceAll("\n", "").includes("REF".repeat(30)));
  assert.match(output.text, /99 x Rp21.474.836/);
  assert.match(output.text, /TOTAL: Rp2.126.008.764/);
  const unsafeName = "Coffee\n\x1b\x00extra\ttext";
  assert.match(formatReceipt({ ...receipt, items: [{ ...receipt.items[0], name: unsafeName }] }).text, /Coffee extra text\n/);
});

test("Jakarta date rolls over year boundaries and midnight uses 00:00", () => {
  assert.match(formatReceipt({ ...receipt, createdAt: "2026-12-31T17:00:00Z" }).text, /01\/01\/2027 00:00 WIB/);
});

test("successful jobs print once, including repeated calls after success", async () => {
  const printer = new FakePrinterAdapter();
  const job = createReceiptPrintJob(receipt, printer);
  assert.deepEqual(await job.print(), { status: "succeeded" });
  assert.deepEqual(await job.print(), { status: "succeeded" });
  assert.equal(printer.attempts.length, 1);
  assert.deepEqual(printer.attempts[0], formatReceipt(receipt));
});

test("failure is retryable and retries retain the exact immutable snapshot", async () => {
  const input = structuredClone(receipt);
  const printer = new FakePrinterAdapter([
    () => { throw new Error("private bridge details"); },
    () => { throw new Error("still unavailable"); },
  ]);
  const job = createReceiptPrintJob(input, printer);
  const failed = await job.print();
  assert.equal(failed.status, "failed");
  assert.ok("error" in failed);
  assert.match(failed.error, /Pembayaran tetap berhasil.*coba lagi/);
  assert.doesNotMatch(failed.error, /private bridge/);
  input.items[0].name = "Mutated client name";
  input.items[0].unitPrice = 999;
  input.total = 999;
  input.payment.changeAmount = 999;
  assert.equal((await job.print()).status, "failed");
  assert.equal((await job.print()).status, "succeeded");
  assert.equal(printer.attempts.length, 3);
  assert.strictEqual(printer.attempts[0], printer.attempts[1]);
  assert.strictEqual(printer.attempts[1], printer.attempts[2]);
  assert.deepEqual(printer.attempts[2], formatReceipt(receipt));
});

test("duplicate calls and concurrent jobs are blocked without queuing", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const printer = new FakePrinterAdapter([() => pending]);
  const first = createReceiptPrintJob(receipt, printer);
  const other = createReceiptPrintJob({ ...receipt, orderNumber: "AR-000124" }, printer);
  const running = first.print();
  try {
    assert.equal((await first.print()).status, "busy");
    assert.equal((await other.print()).status, "busy");
    assert.equal(printer.attempts.length, 1);
  } finally { finish(); }
  assert.equal((await running).status, "succeeded");
  assert.equal(printer.attempts.length, 1); // Blocked work is not silently queued.
  assert.equal((await other.print()).status, "succeeded");
  assert.equal(printer.attempts.length, 2);
});

test("a rejected job releases the register for other jobs and default adapter never fakes success", async () => {
  const failed = createReceiptPrintJob(receipt, new FakePrinterAdapter([() => { throw new Error(); }]));
  assert.equal((await failed.print()).status, "failed");
  assert.equal((await createReceiptPrintJob(receipt, new FakePrinterAdapter()).print()).status, "succeeded");
  const unavailable = createReceiptPrintJob(receipt);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await unavailable.print();
    assert.equal(result.status, "failed");
    assert.ok("error" in result);
    assert.match(result.error, /Printer belum dikonfigurasi.*Pembayaran tetap berhasil/);
  }
});
