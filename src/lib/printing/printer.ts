import { formatReceipt, type PrintReceipt, type Receipt } from "./receipt-format";
import type { PrintCupLabel } from "./cup-label-format";

export interface PrinterAdapter {
  readonly mode?: "physical" | "simulation";
  readonly destination?: "receipt";
  print(receipt: PrintReceipt): Promise<void>;
}

export interface LabelPrinterAdapter {
  readonly mode?: "physical" | "simulation";
  readonly destination?: "labels";
  print(label: PrintCupLabel): Promise<void>;
}

class PrinterNotConfiguredError extends Error {}

// Physical transport must be configured and verified separately. Simulation is
// explicit and returns `simulated`, never a claim that paper was produced.
export const unconfiguredPrinter: PrinterAdapter = {
  mode: "physical", destination: "receipt",
  async print() { throw new PrinterNotConfiguredError(); },
};
export const unconfiguredLabelPrinter: LabelPrinterAdapter = {
  mode: "physical", destination: "labels",
  async print() { throw new PrinterNotConfiguredError(); },
};

export type PrintResult = { status: "succeeded" } | { status: "simulated" } | { status: "failed" | "busy"; error: string };

// Two independent destination lanes in this app instance, including jobs from a
// reopened panel. A live receipt job never blocks labels or vice versa. No queue,
// automatic retry, or timeout that releases a potentially live physical job.
const printing = { receipt: false, labels: false };

type SimulationStep = () => void | Promise<void>;

/** Controlled steps may fail or wait to exercise retries without hardware.
 * An omitted step completes a simulation only; no transport is contacted. */
export function createSimulatedReceiptAdapter(steps: readonly SimulationStep[] = []): PrinterAdapter {
  const pending = [...steps];
  return { mode: "simulation", destination: "receipt", async print() { await pending.shift()?.(); } };
}

export function createSimulatedLabelAdapter(steps: readonly SimulationStep[] = []): LabelPrinterAdapter {
  const pending = [...steps];
  return { mode: "simulation", destination: "labels", async print() { await pending.shift()?.(); } };
}

function createPrintJob(destination: "receipt" | "labels", mode: PrinterAdapter["mode"], print: () => Promise<void>) {
  let completed: "succeeded" | "simulated" | null = null;
  return {
    async print(): Promise<PrintResult> {
      if (completed) return { status: completed };
      if (printing[destination]) return { status: "busy", error: "Printer sedang digunakan. Tunggu hingga selesai, lalu coba lagi." };
      printing[destination] = true;
      try {
        await print();
        completed = mode === "simulation" ? "simulated" : "succeeded";
        return { status: completed };
      } catch (error) {
        const output = destination === "receipt" ? "Struk" : "Label";
        return { status: "failed", error: error instanceof PrinterNotConfiguredError
          ? "Printer belum dikonfigurasi. Pembayaran tetap berhasil. Coba lagi setelah printer siap."
          : mode === "simulation"
            ? `Simulasi ${output.toLowerCase()} gagal. Pembayaran tetap berhasil. Coba simulasi lagi.`
            : `${output} gagal dicetak. Pembayaran tetap berhasil. Periksa printer lalu coba lagi.` };
      } finally {
        printing[destination] = false;
      }
    },
  };
}

/** Input must be the successful getReceiptAction response, never cart state.
 * getReceipt enforces PAID + SUCCEEDED and authorization on the server.
 * Capture the formatted snapshot once; retries never reread mutable data.
 * A successful job is terminal. Historical reprints explicitly request COPY
 * formatting after fetching an authorized receipt through getReceiptAction. */
export function createReceiptPrintJob(receipt: Receipt, adapter: PrinterAdapter = unconfiguredPrinter, copy = false) {
  const snapshot = formatReceipt(receipt, copy);
  return createPrintJob("receipt", adapter.mode, () => adapter.print(snapshot));
}

/** One job per cup permits retrying that cup without reprinting completed cups.
 * Snapshot again so callers cannot mutate a hand-built preview during a retry. */
export function createCupLabelPrintJob(label: PrintCupLabel, adapter: LabelPrinterAdapter = unconfiguredLabelPrinter) {
  const snapshot = Object.freeze({ ...label });
  return createPrintJob("labels", adapter.mode, () => adapter.print(snapshot));
}
