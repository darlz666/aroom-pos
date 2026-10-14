"use client";

import { useRef, useState } from "react";
import {
  createCupLabelPrintJob, createReceiptPrintJob, createSimulatedLabelAdapter, createSimulatedReceiptAdapter,
  type LabelPrinterAdapter, type PrinterAdapter, type PrintResult,
} from "@/lib/printing/printer";
import { formatReceipt, type Receipt } from "@/lib/printing/receipt-format";
import { formatCupLabels, type PrintCupLabel } from "@/lib/printing/cup-label-format";

export type { Receipt } from "@/lib/printing/receipt-format";
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function ReceiptPanel({ receipt, onClose, printerAdapter, labelPrinterAdapter, copy = false }: {
  receipt: Receipt; onClose: () => void; printerAdapter?: PrinterAdapter; labelPrinterAdapter?: LabelPrinterAdapter; copy?: boolean;
}) {
  const { payment } = receipt;
  const labels = formatCupLabels(receipt, copy);
  return <section aria-label="Pratinjau struk" className="col-span-full overflow-y-auto rounded-xl border border-[#a8aea0] bg-[#fffefa] p-6">
    <div className="mx-auto max-w-md space-y-4 break-words">
      <h2 className="text-center text-2xl font-semibold">AROOM Coffee Bar</h2>
      {copy && <p className="text-center text-xl font-semibold">COPY / SALINAN</p>}
      <div>
        <p>Nomor pesanan: {receipt.orderNumber}</p>
        <p>Kasir: {receipt.cashier}</p>
        <p>Pelanggan: {receipt.customerName || "-"}</p>
        <p>{receipt.orderType === "DINE_IN" ? "Dine-in" : "Takeaway"}</p>
        <p>Waktu pesanan: <time dateTime={receipt.createdAt}>{dateTime(receipt.createdAt)} WIB</time></p>
      </div>
      <ul aria-label="Item pesanan" className="space-y-3 border-y border-dashed border-[#a8aea0] py-4">
        {receipt.items.map((item, index) => <li key={index}>
          <p className="font-semibold">{item.name}</p>
          <div className="flex justify-between gap-4"><span>{item.quantity} × {rupiah(item.unitPrice)}</span><span>{rupiah(item.lineTotal)}</span></div>
          {item.notes && <p>Catatan: {item.notes}</p>}
        </li>)}
      </ul>
      <p className="flex justify-between gap-4 text-xl font-semibold"><span>Total</span><span>{rupiah(receipt.total)}</span></p>
      <div className="space-y-1">
        <p>Pembayaran: {payment.method === "CASH" ? "Tunai" : payment.method === "BCA_EDC" ? "BCA EDC" : "QRIS"} · Lunas</p>
        <p>Jumlah pembayaran: {rupiah(payment.amount)}</p>
        {payment.method === "CASH" && <>
          {payment.cashReceived !== null && <p>Uang diterima: {rupiah(payment.cashReceived)}</p>}
          {payment.changeAmount !== null && <p>Kembalian: {rupiah(payment.changeAmount)}</p>}
        </>}
        {payment.method === "BCA_EDC" && payment.edcReference && <p>Referensi EDC: {payment.edcReference}</p>}
      </div>
      <ReceiptPrintControls key={copy ? `${receipt.orderNumber}:copy` : receipt.orderNumber} receipt={receipt} adapter={printerAdapter} copy={copy} />
      <section aria-label="Pratinjau label cup" className="space-y-4 border-t border-[#a8aea0] pt-4">
        <h2 className="text-xl font-semibold">Label cup</h2>
        <p>Tujuan printer label terpisah dari printer struk. Ukuran stiker dan printer fisik belum dikonfigurasi.</p>
        {labels.length === 0 ? <p>Tidak ada label cup tersimpan untuk pesanan ini.</p> : labels.map(label =>
          <CupLabelPrintControls key={`${receipt.orderNumber}:${copy ? "copy:" : ""}cup:${label.cupNumber}`} label={label} adapter={labelPrinterAdapter} />)}
      </section>
      <button type="button" onClick={onClose} className="min-h-12 w-full rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade]">Tutup struk</button>
    </div>
  </section>;
}

type PrintState = PrintResult | { status: "idle" | "printing" };
type PrintJob = { print(): Promise<PrintResult> };
const buttonClass = "min-h-12 w-full rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade] disabled:opacity-40 disabled:cursor-not-allowed";
const pendingOrComplete = (state: PrintState) => ["printing", "succeeded", "simulated"].includes(state.status);
const failed = (state: PrintState): state is Extract<PrintResult, { error: string }> => state.status === "failed" || state.status === "busy";

function usePrintAttempt(job: PrintJob) {
  const [state, setState] = useState<PrintState>({ status: "idle" });
  const busy = useRef(false);
  const completed = useRef(false);
  async function print() {
    if (busy.current || completed.current) return;
    busy.current = true;
    setState({ status: "printing" });
    try {
      const result = await job.print();
      completed.current = result.status === "succeeded" || result.status === "simulated";
      setState(result);
    } finally { busy.current = false; }
  }
  return { state, print };
}

function ReceiptPrintControls({ receipt, adapter, copy }: { receipt: Receipt; adapter?: PrinterAdapter; copy: boolean }) {
  const [preview] = useState(() => formatReceipt(receipt, copy));
  const [job] = useState(() => createReceiptPrintJob(receipt, adapter, copy));
  const [simulationJob] = useState(() => createReceiptPrintJob(receipt, createSimulatedReceiptAdapter(), copy));
  const physical = usePrintAttempt(job);
  const simulation = usePrintAttempt(simulationJob);
  const { state } = physical;
  return <div className="space-y-2">
    <h2 className="text-xl font-semibold">Struk transaksi · 58 mm</h2>
    <pre aria-label="Pratinjau struk 58 mm" className="overflow-x-auto rounded-lg border border-dashed border-[#a8aea0] bg-white p-3 font-mono text-sm">{preview.text}</pre>
    <button type="button" onClick={() => void physical.print()} disabled={pendingOrComplete(state)} className={buttonClass}>
      {state.status === "printing" ? "Mencetak..." : failed(state) ? "Coba Cetak Lagi" : copy ? "Cetak Salinan" : "Cetak Struk"}
    </button>
    {state.status === "printing" && <p role="status">Sedang mencetak struk...</p>}
    {state.status === "succeeded" && <p role="status">Permintaan cetak berhasil.</p>}
    {state.status === "simulated" && <p role="status">Simulasi struk selesai. Belum dicetak secara fisik.</p>}
    {failed(state) && <p role="alert" className="text-[#8b3026]">{state.error}</p>}
    <button type="button" onClick={() => void simulation.print()} disabled={pendingOrComplete(simulation.state)} className={buttonClass}>
      {simulation.state.status === "printing" ? "Mensimulasikan Struk..." : failed(simulation.state) ? "Coba Simulasi Struk Lagi" : "Simulasikan Struk"}
    </button>
    <p>Simulasi tidak mengirim ke printer fisik.</p>
    {simulation.state.status === "printing" && <p role="status">Simulasi struk sedang berlangsung...</p>}
    {simulation.state.status === "simulated" && <p role="status">Simulasi struk selesai. Belum dicetak secara fisik.</p>}
    {failed(simulation.state) && <p role="alert" className="text-[#8b3026]">{simulation.state.error}</p>}
  </div>;
}

function CupLabelPrintControls({ label: input, adapter }: { label: PrintCupLabel; adapter?: LabelPrinterAdapter }) {
  const [label] = useState(() => input);
  const [job] = useState(() => createCupLabelPrintJob(label, adapter));
  const [simulationJob] = useState(() => createCupLabelPrintJob(label, createSimulatedLabelAdapter()));
  const physical = usePrintAttempt(job);
  const simulation = usePrintAttempt(simulationJob);
  const { state } = physical;
  return <article aria-label={`Label cup ${label.cupNumber}`} className="space-y-2 rounded-lg border border-[#a8aea0] p-3">
    <h3 className="font-semibold">Label cup {label.cupNumber}/{label.totalCups}</h3>
    <pre aria-label={`Pratinjau label cup ${label.cupNumber}`} className="overflow-x-auto bg-white p-3 font-mono text-sm">{label.text}</pre>
    <button type="button" onClick={() => void physical.print()} disabled={pendingOrComplete(state)} className={buttonClass}>
      {state.status === "printing" ? `Mencetak Label Cup ${label.cupNumber}...` : failed(state) ? `Coba Cetak Label Cup ${label.cupNumber} Lagi` : `Cetak Label Cup ${label.cupNumber}`}
    </button>
    {state.status === "printing" && <p role="status">Sedang mencetak label cup {label.cupNumber}...</p>}
    {state.status === "succeeded" && <p role="status">Permintaan cetak label cup {label.cupNumber} berhasil.</p>}
    {state.status === "simulated" && <p role="status">Simulasi label cup {label.cupNumber} selesai. Belum dicetak secara fisik.</p>}
    {failed(state) && <p role="alert" className="text-[#8b3026]">{state.error}</p>}
    <button type="button" onClick={() => void simulation.print()} disabled={pendingOrComplete(simulation.state)} className={buttonClass}>
      {simulation.state.status === "printing" ? `Mensimulasikan Label Cup ${label.cupNumber}...` : failed(simulation.state) ? `Coba Simulasi Label Cup ${label.cupNumber} Lagi` : `Simulasikan Label Cup ${label.cupNumber}`}
    </button>
    <p>Simulasi tidak mengirim ke printer fisik.</p>
    {simulation.state.status === "printing" && <p role="status">Simulasi label cup {label.cupNumber} sedang berlangsung...</p>}
    {simulation.state.status === "simulated" && <p role="status">Simulasi label cup {label.cupNumber} selesai. Belum dicetak secara fisik.</p>}
    {failed(simulation.state) && <p role="alert" className="text-[#8b3026]">{simulation.state.error}</p>}
  </article>;
}
