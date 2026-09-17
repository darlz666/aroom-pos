import type { PrinterAdapter } from "../printer";
import type { PrintReceipt } from "../receipt-format";

/** Test-only adapter. Steps can succeed, throw, or wait for a controlled promise. */
export class FakePrinterAdapter implements PrinterAdapter {
  readonly attempts: PrintReceipt[] = [];
  constructor(private readonly steps: Array<() => void | Promise<void>> = []) {}

  async print(receipt: PrintReceipt): Promise<void> {
    this.attempts.push(receipt);
    await this.steps.shift()?.();
  }
}
