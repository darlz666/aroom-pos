import Link from "next/link";
import { requireRole } from "@/lib/auth/authorization";
import { getDailyReportAction } from "@/lib/reports/action";
import { jakartaBusinessDate } from "@/lib/reports/domain";

const money = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;

export async function FinanceDashboard() {
  await requireRole("FINANCE");
  const date = jakartaBusinessDate();
  const result = await getDailyReportAction(date);
  return <section aria-labelledby="finance-report-title" className="space-y-6">
    <div>
      <h2 id="finance-report-title" className="text-3xl font-semibold">Laporan Hari Ini</h2>
      <p className="mt-2 text-lg text-[#62685c]"><time dateTime={date}>{new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "long" }).format(new Date(`${date}T00:00:00+07:00`))}</time> · WIB</p>
    </div>
    {!result.success ? <div className="space-y-4 rounded-xl border border-[#e5c8c1] bg-[#fcf1ed] p-6">
      <p role="alert">{result.error}</p>
      {/* A full reload retries the server read and recalculates today's Jakarta date. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4">Coba lagi</a>
    </div> : <>
      <div className="rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 sm:p-8">
        <h3 className="text-lg text-[#62685c]">Total Penjualan</h3>
        <p className="mt-3 break-words text-4xl font-semibold tabular-nums sm:text-5xl">{money(result.report.paidSales)}</p>
        <p className="mt-3 text-lg">{result.report.paidOrderCount} transaksi</p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        {([["Tunai", result.report.cashTotal], ["BCA EDC", result.report.edcTotal], ["QRIS", result.report.qrisTotal]] as const).map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-6">
          <dt className="text-[#62685c]">{label}</dt><dd className="mt-2 break-words text-2xl font-semibold tabular-nums">{money(value)}</dd>
        </div>)}
      </dl>
      {result.report.paidOrderCount === 0 && <p>Belum ada transaksi lunas hari ini.</p>}
      <p className="text-sm text-[#62685c]">Ringkasan saat halaman dimuat. Mengikuti penyesuaian Admin; transaksi yang dihapus dari laporan tidak termasuk.</p>
    </>}
    <Link href="/admin/reports" className="inline-flex min-h-14 items-center justify-center rounded-lg bg-[#344631] px-6 py-3 text-lg font-semibold text-white hover:bg-[#293926] focus-visible:outline-2 focus-visible:outline-offset-4">Lihat Laporan Harian</Link>
  </section>;
}
