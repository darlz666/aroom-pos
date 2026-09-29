"use client";

import { useRef, useState } from "react";
import { getDailyReportAction } from "@/lib/reports/action";
import { TransactionEditor } from "./transaction-editor";
import type { DailyReport, ReportTransaction } from "@/lib/reports/service";

import { TransactionActions } from "./transaction-actions";

type Result = Awaited<ReturnType<typeof getDailyReportAction>>;
const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40";
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string, part?: "date" | "time") => new Intl.DateTimeFormat(part ? "en-GB" : "id-ID", {
  timeZone: "Asia/Jakarta",
  ...(part === "date" ? { day: "2-digit", month: "2-digit", year: "numeric" } as const :
    part === "time" ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const :
      { dateStyle: "medium", timeStyle: "short" } as const),
}).format(new Date(value));
const paymentLabels = { CASH: "Tunai", BCA_EDC: "BCA EDC", MIDTRANS_QRIS: "QRIS" };

type Selection = { ids: string[]; toggle: (id: string) => void; all: () => void; edit: (row: ReportTransaction) => void; remove: (rows: ReportTransaction[]) => void };
export function DailyReportSummary({ report, role = "", selection }: { report: DailyReport; role?: string; selection?: Selection }) {
  return <div className="space-y-8">
    <section aria-label="Penjualan harian" className="space-y-4">
      <h2 className="text-xl font-semibold">Penjualan tanggal {report.businessDate} · WIB</h2>
      <p>Penjualan mengikuti tanggal dan penyesuaian Admin. Potongan channel tidak mengurangi total penjualan. Transaksi yang dihapus dari laporan tidak termasuk. Ringkasan saat dimuat.</p>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {([
          ["Total Penjualan", rupiah(report.paidSales)], ["Pesanan Lunas", report.paidOrderCount],
          ["Tunai", rupiah(report.cashTotal)], ["BCA EDC", rupiah(report.edcTotal)], ["QRIS", rupiah(report.qrisTotal)],
        ] as const).map(([label, value]) => <div key={label} className="rounded-xl border border-[#dedfd5] bg-[#fffefa] p-5">
          <dt>{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
        </div>)}
      </dl>
      {report.paidOrderCount === 0 && <p>Belum ada pembayaran berhasil pada tanggal ini.</p>}
    </section>
    <section aria-label="Rekonsiliasi shift" className="space-y-4">
      <h2 className="text-xl font-semibold">Rekonsiliasi per shift</h2>
      <p>Shift yang berlangsung pada tanggal ini, termasuk yang ditutup tepat pukul 00.00 WIB. Nilai mencakup seluruh shift, termasuk lintas tengah malam, bukan hanya penjualan tanggal ini. Nilai penutupan tersimpan tidak dihitung ulang. Rekonsiliasi kas memakai pembayaran asli; penyesuaian dan penghapusan dari laporan tidak mengubah kas fisik atau nilai penutupan shift.</p>
      {report.shifts.length === 0 && <p>Tidak ada shift pada tanggal ini.</p>}
      {report.shifts.map(shift => <article key={shift.id} className="space-y-4 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-5">
        <h3 className="text-lg font-semibold">{shift.cashierName} · {shift.status === "CLOSED" ? "Ditutup" : "Terbuka"}</h3>
        <p>Dibuka: {dateTime(shift.openedAt)} WIB<br />Ditutup: {shift.closedAt ? `${dateTime(shift.closedAt)} WIB` : "Belum ditutup"}</p>
        {shift.status === "OPEN" && <p>Kas yang diharapkan saat dimuat; kas fisik dan selisih belum ditetapkan.</p>}
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {([
            ["Kas awal", shift.openingCash], ["Kas yang diharapkan", shift.expectedCash],
            ["Kas fisik", shift.countedCash], ["Selisih kas", shift.variance],
          ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{value === null ? "Belum ditetapkan" : rupiah(value)}</dd></div>)}
        </dl>
      </article>)}
    </section>
    <section aria-label="Detail transaksi" className="space-y-4">
      <h2 className="text-xl font-semibold">Detail transaksi</h2>
      <p>Daftar transaksi lunas pada tanggal laporan, termasuk penyesuaian Admin.</p>
      {role === "ADMIN" && selection && report.transactions.length > 0 && <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={control} onClick={selection.all}>Pilih semua</button>
        <span>{selection.ids.length} transaksi dipilih</span>
        <button type="button" className={control} disabled={!selection.ids.length} onClick={() => selection.remove(report.transactions.filter(row => selection.ids.includes(row.orderId)))}>Hapus Terpilih</button>
      </div>}
      <p className="text-sm">Pelanggan / meja belum tersedia. Diskon voucher, promo POS, piutang, dan iklan ditampilkan Rp0 karena belum dicatat. Total Omzet adalah penjualan sebelum biaya channel. Penyesuaian hanya mengubah nilai laporan; pembayaran dan bukti Order asli tetap, termasuk rekonsiliasi shift yang tersimpan. HPP dan laba tersedia hanya jika seluruh HPP penyesuaian diketahui.</p>
      {report.transactions.length === 0 ? <p>Belum ada transaksi lunas pada tanggal ini.</p> :
        <div className="overflow-x-auto rounded-xl border border-[#dedfd5] bg-[#fffefa]" tabIndex={0} role="region" aria-label="Tabel detail transaksi">
          <table className="w-full min-w-[2200px] text-left text-sm">
            <thead className="bg-[#e9eade]">
              <tr>{role === "ADMIN" && selection && <th className="px-4 py-4"><input type="checkbox" className="h-6 w-6" aria-label="Pilih semua transaksi" checked={selection.ids.length === report.transactions.length} ref={node => { if (node) node.indeterminate = selection.ids.length > 0 && selection.ids.length < report.transactions.length; }} onChange={selection.all} /></th>}{["No. Pesanan", "Tanggal", "Jam", "Pelanggan / Meja", "Produk", "Qty", "Status Pembayaran", "Harga Jual", "Total Omzet", "Diskon Voucher", "Promo POS", "Piutang", "HPP", "Potongan Channel", "Iklan", "Total Potongan / Beban", "Gross Profit", "Pendapatan Bersih", "Aksi"].map(label =>
                <th key={label} scope="col" className="whitespace-nowrap px-4 py-4 font-semibold">{label}</th>)}</tr>
            </thead>
            <tbody>{report.transactions.map(transaction => <tr key={transaction.orderId} className="border-t border-[#dedfd5] align-top">
              {role === "ADMIN" && selection && <td className="px-4 py-4"><input type="checkbox" className="h-6 w-6" aria-label={`Pilih ${transaction.orderNumber}`} checked={selection.ids.includes(transaction.orderId)} onChange={() => selection.toggle(transaction.orderId)} /></td>}
              <th scope="row" className="whitespace-nowrap px-4 py-4 font-semibold">{transaction.orderNumber}</th>
              <td className="whitespace-nowrap px-4 py-4">{dateTime(transaction.paidAt, "date")}</td>
              <td className="whitespace-nowrap px-4 py-4">{dateTime(transaction.paidAt, "time")} WIB</td>
              <td className="px-4 py-4">{transaction.customerLabel ?? "-"}</td>
              <td className="min-w-72 max-w-96 break-words px-4 py-4">{transaction.productsLabel}</td>
              <td className="px-4 py-4 tabular-nums">{transaction.quantity}</td>
              <td className="whitespace-nowrap px-4 py-4">Lunas · {paymentLabels[transaction.paymentMethod]}</td>
              {(["sellingPrice", "totalRevenue", "voucherDiscount", "posPromo", "receivable", "hpp", "channelFee", "adsCost", "totalDeductions", "grossProfit", "netRevenue"] as const).map(field =>
                <td key={field} className="whitespace-nowrap px-4 py-4 text-right tabular-nums">{transaction[field] === null ? "-" : rupiah(transaction[field])}</td>)}
              <td className="px-4 py-4"><TransactionActions transaction={transaction} role={role} onEdit={() => selection?.edit(transaction)} onVoid={() => selection?.remove([transaction])} /></td>
            </tr>)}</tbody>
          </table>
        </div>}
    </section>
  </div>;
}

export function DailyReportPanel({ initialDate, initial, role }: { initialDate: string; initial: Result; role: string }) {
  const [date, setDate] = useState(initialDate);
  const [report, setReport] = useState<DailyReport | null>(initial.success ? initial.report : null);
  const [error, setError] = useState<string | null>(initial.success ? null : initial.error);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ mode: "edit" | "void"; transactions: ReportTransaction[] } | null>(null);
  const request = useRef(0);
  const busy = useRef(false);

  function changeDate(value: string) {
    setSelected([]);
    request.current++;
    busy.current = false;
    setLoading(false);
    setDate(value);
    setReport(null);
    setError(null);
  }
  async function load() {
    if (busy.current) return;
    busy.current = true;
    setSelected([]);
    const current = ++request.current;
    setLoading(true);
    setReport(null);
    setError(null);
    try {
      const result = await getDailyReportAction(date);
      if (current !== request.current) return;
      if (result.success) setReport(result.report);
      else setError(result.error);
    } catch {
      if (current === request.current) setError("Laporan belum dapat dimuat. Periksa koneksi lalu coba lagi.");
    } finally {
      if (current === request.current) { busy.current = false; setLoading(false); }
    }
  }
  return <div className="space-y-6">
    <form className="flex flex-wrap items-end gap-4" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="grid gap-2 font-semibold">Tanggal bisnis (WIB)
        <input type="date" required className={control} value={date} onChange={event => changeDate(event.target.value)} />
      </label>
      <button type="submit" className={control} disabled={loading}>{loading ? "Memuat…" : error ? "Coba lagi" : "Muat laporan"}</button>
    </form>
    {loading && <p role="status">Memuat laporan…</p>}
    {error && <p role="alert">{error}</p>}
    {editor && report && role === "ADMIN" && <TransactionEditor {...editor} businessDate={report.businessDate} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void load(); }} />}
    {report && <DailyReportSummary report={report} role={role} selection={role === "ADMIN" ? {
      ids: selected, toggle: id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]),
      all: () => setSelected(current => current.length === report.transactions.length ? [] : report.transactions.map(row => row.orderId)),
      edit: row => setEditor({ mode: "edit", transactions: [row] }), remove: rows => setEditor({ mode: "void", transactions: rows }),
    } : undefined} />}
  </div>;
}
