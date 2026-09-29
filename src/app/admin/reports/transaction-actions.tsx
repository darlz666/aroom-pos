"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getReportReceiptAction } from "@/lib/reports/action";
import type { ReportTransaction } from "@/lib/reports/service";
import { createReceiptPrintJob } from "@/lib/printing/printer";

const button = "inline-flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-[#a8aea0] px-3 py-2 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40";
const money = (value: number | null) => value === null ? "-" : `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const date = (value: string, time = false) => new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta", ...(time ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const :
    { day: "2-digit", month: "2-digit", year: "numeric" } as const),
}).format(new Date(value));

function Icon({ kind }: { kind: "eye" | "pencil" | "printer" | "trash" }) {
  const paths = {
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    pencil: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" />,
    printer: <><path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6Z" /><path d="M17 11h1" /></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

export function TransactionActions({ transaction, role, onEdit, onVoid }: { transaction: ReportTransaction; role: string; onEdit?: () => void; onVoid?: () => void }) {
  const [mode, setMode] = useState<"detail" | "print" | null>(null);
  if (!["ADMIN", "CASHIER", "FINANCE"].includes(role)) return null;
  return <>
    <div className="flex gap-2">
      <button type="button" className={button} aria-label="Lihat detail" title="Lihat detail" onClick={() => setMode("detail")}><Icon kind="eye" /></button>
      {role === "ADMIN" && <button type="button" className={button} aria-label="Edit transaksi" title="Edit transaksi" onClick={onEdit}><Icon kind="pencil" /></button>}
      <button type="button" className={button} aria-label="Cetak ulang struk" title="Cetak ulang struk" onClick={() => setMode("print")}><Icon kind="printer" /></button>
      {role === "ADMIN" && <button type="button" className={button} aria-label="Hapus transaksi" title="Hapus transaksi" onClick={onVoid}><Icon kind="trash" /></button>}
    </div>
    {mode && <TransactionModal transaction={transaction} mode={mode} onClose={() => setMode(null)} />}
  </>;
}

export function TransactionDetails({ transaction: t }: { transaction: ReportTransaction }) {
  const groups: [string, [string, ReactNode][]][] = [
    ["Identitas", [["No. Pesanan", t.orderNumber], ["Tanggal Pembayaran", date(t.paidAt)],
      ["Jam", `${date(t.paidAt, true)} WIB`], ["Pelanggan / Meja", t.customerLabel ?? "-"],
      ["Metode Pembayaran", { CASH: "Tunai", BCA_EDC: "BCA EDC", MIDTRANS_QRIS: "QRIS" }[t.paymentMethod]]]],
    ["Produk", [["Produk", t.productsLabel], ["Qty", t.quantity], ["Harga Jual", money(t.sellingPrice)]]],
    ["Ringkasan Keuangan", [["Total Omzet", money(t.totalRevenue)], ["HPP", money(t.hpp)], ["Gross Profit", money(t.grossProfit)]]],
    ["Beban", [["Potongan Channel", money(t.channelFee)], ["Iklan", money(t.adsCost)],
      ["Diskon Voucher", money(t.voucherDiscount)], ["Promo POS", money(t.posPromo)], ["Total Potongan", money(t.totalDeductions)]]],
    ["Hasil", [["Pendapatan Bersih", money(t.netRevenue)], ["Piutang", money(t.receivable)]]],
  ];
  return <div className="space-y-6">
    {t.revision > 0 && <span className="inline-block rounded-full bg-[#e9eade] px-3 py-1 text-sm">Disesuaikan Admin</span>}
    {groups.map(([title, fields]) => <section key={title} aria-label={title} className="space-y-3 border-t border-[#dedfd5] pt-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      <dl className="grid gap-4 sm:grid-cols-2">{fields.map(([label, value]) => <div key={label}>
        <dt className="text-sm text-[#62685c]">{label}</dt><dd className="break-words font-semibold tabular-nums">{value}</dd>
      </div>)}</dl>
    </section>)}
  </div>;
}

export function TransactionModal({ transaction, mode, onClose }: {
  transaction: ReportTransaction; mode: "detail" | "print"; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const completed = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "printing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function print() {
    if (busy.current || completed.current) return;
    busy.current = true;
    setState("loading");
    setError(null);
    try {
      const result = await getReportReceiptAction(transaction.orderId);
      if (!result.success) { setError(result.error); setState("idle"); return; }
      setState("printing");
      const printed = await createReceiptPrintJob(result.receipt, undefined, true).print();
      if (printed.status === "succeeded") { completed.current = true; setState("done"); }
      else { setError(printed.error); setState("idle"); }
    } catch {
      setError("Struk belum dapat dimuat. Periksa koneksi lalu coba lagi.");
      setState("idle");
    } finally { busy.current = false; }
  }
  const pending = state === "loading" || state === "printing";
  return <dialog ref={dialog} aria-labelledby={`transaction-title-${transaction.orderId}`}
    onCancel={event => { if (busy.current) event.preventDefault(); }} onClose={onClose}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[min(42rem,95vw)] overflow-y-auto rounded-xl border border-[#a8aea0] bg-[#fffefa] p-6 text-[#292e28] shadow-xl backdrop:bg-black/40">
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <h2 id={`transaction-title-${transaction.orderId}`} className="text-2xl font-semibold">{mode === "detail" ? "Detail Transaksi" : "Cetak Ulang Struk"}</h2>
        <button type="button" className={button} aria-label="Tutup" disabled={pending} onClick={onClose}>Tutup</button>
      </header>
      {mode === "detail" ? <TransactionDetails transaction={transaction} /> : <p>{transaction.orderNumber} · COPY / SALINAN</p>}
      <p className="text-sm">Cetak ulang menggunakan struk pembayaran asli. Penyesuaian laporan tidak mengubah bukti pembayaran.</p>
      {pending && <p role="status">{state === "loading" ? "Memuat struk…" : "Mencetak struk…"}</p>}
      {error && <p role="alert" className="text-[#8b3026]">{error}</p>}
      {state === "done" && <p role="status">Permintaan cetak berhasil.</p>}
      <button type="button" className={button} disabled={pending || state === "done"} onClick={() => void print()}>Cetak Ulang Struk</button>
    </div>
  </dialog>;
}
