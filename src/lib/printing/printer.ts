import { formatReceipt, type PrintReceipt, type Receipt } from "./receipt-format";

export interface PrinterAdapter {
  print(receipt: PrintReceipt): Promise<void>;
}

class PrinterNotConfiguredError extends Error {}

// Never report a pretend success in the application. Only tests use a fake.
export const unconfiguredPrinter: PrinterAdapter = {
  async print() { throw new PrinterNotConfiguredError(); },
};

export type PrintResult = { status: "succeeded" } | { status: "failed" | "busy"; error: string };

// One register: block overlapping jobs in this app instance, including jobs from
// a reopened panel. No queue, automatic retry, or timeout that releases a live job.
let printing = false;

/** Input must be the successful getReceiptAction response, never cart state.
 * getReceipt enforces PAID + SUCCEEDED and authorization on the server.
 * Capture the formatted snapshot once; retries never reread mutable data.
 * A successful job is terminal. Historical reprints explicitly request COPY
 * formatting after fetching an authorized receipt through getReceiptAction. */
export function createReceiptPrintJob(receipt: Receipt, adapter: PrinterAdapter = unconfiguredPrinter, copy = false) {
  const snapshot = formatReceipt(receipt, copy);
  let succeeded = false;
  return {
    async print(): Promise<PrintResult> {
      if (succeeded) return { status: "succeeded" };
      if (printing) return { status: "busy", error: "Printer sedang digunakan. Tunggu hingga selesai, lalu coba lagi." };
      printing = true;
      try {
        await adapter.print(snapshot);
        succeeded = true;
        return { status: "succeeded" };
      } catch (error) {
        return { status: "failed", error: error instanceof PrinterNotConfiguredError
          ? "Printer belum dikonfigurasi. Pembayaran tetap berhasil. Coba lagi setelah printer siap."
          : "Struk gagal dicetak. Pembayaran tetap berhasil. Periksa printer lalu coba lagi." };
      } finally {
        printing = false;
      }
    },
  };
}
