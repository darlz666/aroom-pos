"use client";

import { useRef, useState } from "react";
import { getDailyReportAction } from "@/lib/reports/action";
import type { DailyReport } from "@/lib/reports/service";

type Result = Awaited<ReturnType<typeof getDailyReportAction>>;
const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40";
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function DailyReportSummary({ report }: { report: DailyReport }) {
  return <div className="space-y-8">
    <section aria-label="Penjualan harian" className="space-y-4">
      <h2 className="text-xl font-semibold">Penjualan tanggal {report.businessDate} · WIB</h2>
      <p>Berdasarkan waktu pembayaran berhasil. Ringkasan saat dimuat.</p>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {([
          ["Total penjualan lunas", rupiah(report.paidSales)], ["Pesanan lunas", report.paidOrderCount],
          ["Tunai", rupiah(report.cashTotal)], ["BCA EDC", rupiah(report.edcTotal)], ["QRIS", rupiah(report.qrisTotal)],
        ] as const).map(([label, value]) => <div key={label} className="rounded-xl border border-[#dedfd5] bg-[#fffefa] p-5">
          <dt>{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
        </div>)}
      </dl>
      {report.paidOrderCount === 0 && <p>Belum ada pembayaran berhasil pada tanggal ini.</p>}
    </section>
    <section aria-label="Rekonsiliasi shift" className="space-y-4">
      <h2 className="text-xl font-semibold">Rekonsiliasi per shift</h2>
      <p>Shift yang berlangsung pada tanggal ini, termasuk yang ditutup tepat pukul 00.00 WIB. Nilai mencakup seluruh shift, termasuk lintas tengah malam, bukan hanya penjualan tanggal ini. Nilai penutupan tersimpan tidak dihitung ulang.</p>
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
  </div>;
}

export function DailyReportPanel({ initialDate, initial }: { initialDate: string; initial: Result }) {
  const [date, setDate] = useState(initialDate);
  const [report, setReport] = useState<DailyReport | null>(initial.success ? initial.report : null);
  const [error, setError] = useState<string | null>(initial.success ? null : initial.error);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);

  function changeDate(value: string) {
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
    {report && <DailyReportSummary report={report} />}
  </div>;
}
