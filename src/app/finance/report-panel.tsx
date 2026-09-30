"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { financeReportAction, financeHistoryAction } from "@/lib/finance/actions";
import { defaultPeriod, type PeriodInput } from "@/lib/finance/domain";
import { jakartaBusinessDate } from "@/lib/reports/domain";

export const control = "min-h-14 rounded-lg border border-[#a8aea0] bg-white px-4 py-3 text-base";
export const money = (n: number | null) => n === null ? "-" : `Rp${new Intl.NumberFormat("id-ID").format(n)}`;
const labels = { DAY: "Harian", MONTH: "Bulanan", YEAR: "Tahunan", LIFETIME: "Lifetime" };
export function PeriodControls({ period, onChange, fixed = false, compact = false }: { period: PeriodInput; onChange: (p: PeriodInput) => void; fixed?: boolean; compact?: boolean }) {
  const today = jakartaBusinessDate();
  if (compact) return <div className="flex flex-wrap items-center gap-3">
    <div role="group" aria-label="Periode laporan" className="flex max-w-full flex-wrap gap-1 rounded-xl bg-[#f2f4f3] p-1">
      {Object.entries(labels).map(([key, label]) => <button key={key} type="button" aria-pressed={period.type === key} className={`${compactControl} ${period.type === key ? "bg-white text-[#24634d] shadow-sm" : "text-[#62716a] hover:bg-white/70"}`} onClick={() => {
        const type = key as PeriodInput["type"];
        onChange({ type, value: type === "LIFETIME" ? undefined : today.slice(0, type === "DAY" ? 10 : type === "MONTH" ? 7 : 4) });
      }}>{label}</button>)}
    </div>
    {period.type !== "LIFETIME" && <label className="flex flex-wrap items-center gap-2 text-sm text-[#62716a]">{period.type === "DAY" ? "Tanggal" : period.type === "MONTH" ? "Bulan" : "Tahun"}<input className={`${compactControl} min-w-0 max-w-full border border-[#dfe5e1] bg-white text-[#23382e]`} aria-label="Tanggal periode" type={period.type === "DAY" ? "date" : period.type === "MONTH" ? "month" : "number"} min={period.type === "YEAR" ? 1000 : undefined} max={period.type === "YEAR" ? 9999 : undefined} value={period.value ?? ""} onChange={e => onChange({ ...period, value: e.target.value })} /></label>}
  </div>;
  return <div className="flex flex-wrap items-end gap-3">
    {!fixed && <label className="grid gap-2">Periode<select className={control} value={period.type} onChange={e => {
      const type = e.target.value as PeriodInput["type"];
      onChange({ type, value: type === "LIFETIME" ? undefined : today.slice(0, type === "DAY" ? 10 : type === "MONTH" ? 7 : 4) });
    }}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
    {period.type !== "LIFETIME" && <label className="grid gap-2">{period.type === "DAY" ? "Tanggal" : period.type === "MONTH" ? "Bulan dan tahun" : "Tahun"}<input className={control} aria-label="Tanggal periode" type={period.type === "DAY" ? "date" : period.type === "MONTH" ? "month" : "number"} min={period.type === "YEAR" ? 1000 : undefined} max={period.type === "YEAR" ? 9999 : undefined} value={period.value ?? ""} onChange={e => onChange({ ...period, value: e.target.value })} /></label>}
  </div>;
}
type Result = Awaited<ReturnType<typeof financeReportAction>> | { success: false; error: string };
const compactControl = "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24634d]";
const card = "rounded-2xl border border-[#e2e7e3] bg-white shadow-[0_2px_8px_0_rgba(25,50,35,0.03)]";
const sources = { ALL: "Semua", cashTotal: "Tunai", edcTotal: "BCA EDC", qrisTotal: "QRIS" };
type Source = keyof typeof sources;
type Report = Extract<Result, { success: true }>["data"];

function periodLabel(period: PeriodInput) {
  if (period.type === "LIFETIME") return "Lifetime · Seluruh periode pencatatan";
  const value = period.value ?? "";
  if (period.type === "YEAR") return `Tahunan · ${value || "Pilih tahun"}`;
  const date = new Date(`${value}${period.type === "MONTH" ? "-01" : ""}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime())) return "Pilih periode laporan";
  return `${labels[period.type]} · ${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: period.type === "DAY" ? "numeric" : undefined, month: "long", year: "numeric" }).format(date)}`;
}

export function FinanceTrend({ rows, source, period }: { rows: Report["breakdown"]; source: Source; period: PeriodInput }) {
  const salesKey = source === "ALL" ? "paidSales" : source;
  // These coordinates only scale server values for display; no financial totals are derived here.
  const values = rows.flatMap(row => [row[salesKey], row.operatingExpenses, row.netIncome ?? 0]);
  const maximum = Math.max(1, ...values), minimum = Math.min(0, ...values);
  const x = (index: number) => 88 + index * 700 / Math.max(1, rows.length - 1);
  const y = (value: number) => 222 - (value - minimum) / (maximum - minimum) * 182;
  const axisMoney = (value: number) => new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const tickLabel = (key: string) => period.type === "YEAR" ? new Intl.DateTimeFormat("id-ID", { month: "short", timeZone: "Asia/Jakarta" }).format(new Date(`${key}-01T00:00:00+07:00`)) : key.slice(-2);
  return <section aria-label="Tren pemasukan dan pengeluaran" className={`${card} min-w-0 p-5 sm:p-6`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold text-[#23382e]">Tren Cashflow</h3><p className="mt-1 text-sm text-[#62716a]">Penjualan {source === "ALL" ? "semua metode" : sources[source]}; pengeluaran dan pendapatan bersih mencakup semua metode.</p></div>
      <div className="flex flex-wrap gap-4 text-xs text-[#62716a]"><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#348064]" />Pemasukan</span><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#c17b42]" />Pengeluaran</span><span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#6878b7]" />Pendapatan Bersih</span></div>
    </div>
    {rows.length === 0 ? <div className="mt-5 flex min-h-36 items-center justify-center rounded-xl bg-[#f7f9f7] p-6 text-center text-sm leading-6 text-[#62716a]">Tren tersedia pada periode Bulanan dan Tahunan. Pilih salah satu periode untuk melihat pergerakan keuangan.</div> : <>
      <svg viewBox="0 0 820 268" role="img" aria-label={`Tren penjualan ${sources[source]} dan pengeluaran operasional dalam rupiah. Nilai lengkap tersedia di tabel di bawah.`} className="mt-3 block max-h-64 w-full">
        {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1="88" x2="788" y1={y(minimum + (maximum - minimum) * fraction)} y2={y(minimum + (maximum - minimum) * fraction)} stroke="#e8ede9" strokeDasharray="4 5" /><text x="76" y={y(minimum + (maximum - minimum) * fraction) + 4} textAnchor="end" fontSize="12" fill="#62716a">Rp{axisMoney(minimum + (maximum - minimum) * fraction)}</text></g>)}
        <polyline points={rows.map((row, i) => `${x(i)},${y(row[salesKey])}`).join(" ")} fill="none" stroke="#348064" strokeWidth="3" strokeLinejoin="round" />
        <polyline points={rows.map((row, i) => `${x(i)},${y(row.operatingExpenses)}`).join(" ")} fill="none" stroke="#c17b42" strokeWidth="3" strokeDasharray="7 5" strokeLinejoin="round" />
        {rows.map((row, i) => row.netIncome !== null && i > 0 && rows[i - 1].netIncome !== null ? <line key={`net-${row.key}`} x1={x(i - 1)} y1={y(rows[i - 1].netIncome!)} x2={x(i)} y2={y(row.netIncome)} stroke="#6878b7" strokeWidth="3" /> : null)}
        {rows.map((row, i) => <g key={row.key}>
          {row.netIncome !== null && <circle cx={x(i)} cy={y(row.netIncome)} r="3" fill="#6878b7"><title>{row.key}: Pendapatan Bersih {money(row.netIncome)}</title></circle>}
          <circle cx={x(i)} cy={y(row[salesKey])} r="3" fill="#348064"><title>{row.key}: Pemasukan {money(row[salesKey])}</title></circle>
          <circle cx={x(i)} cy={y(row.operatingExpenses)} r="3" fill="#c17b42"><title>{row.key}: Pengeluaran {money(row.operatingExpenses)}</title></circle>
          {(i === 0 || i === rows.length - 1 || i % Math.ceil(rows.length / 7) === 0) && <text x={x(i)} y="252" textAnchor="middle" fontSize="12" fill="#62716a">{tickLabel(row.key)}</text>}
        </g>)}
      </svg>
      <details className="mt-3 border-t border-[#edf0ed] pt-2 text-sm">
        <summary className="min-h-11 cursor-pointer content-center font-medium text-[#24634d]">Lihat angka per {period.type === "YEAR" ? "bulan" : "hari"}</summary>
        <div className="max-h-80 overflow-auto"><table className="w-full text-left"><caption className="sr-only">Nilai tren dalam rupiah</caption><thead><tr>{[period.type === "YEAR" ? "Bulan" : "Tanggal", `Pemasukan · ${sources[source]}`, "Pengeluaran operasional", "Pendapatan Bersih"].map(label => <th scope="col" key={label} className="p-3 text-xs font-medium text-[#62716a]">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.key} className="border-t border-[#edf0ed]"><th scope="row" className="whitespace-nowrap p-3 font-normal">{row.key}</th><td className="whitespace-nowrap p-3 tabular-nums">{money(row[salesKey])}</td><td className="whitespace-nowrap p-3 tabular-nums">{money(row.operatingExpenses)}</td><td className="whitespace-nowrap p-3 tabular-nums">{money(row.netIncome)}</td></tr>)}</tbody></table></div>
      </details>
    </>}
  </section>;
}

const categoryColors = ["#348064", "#6878b7", "#c17b42", "#4995a4", "#ab7294", "#849a52", "#c59b42", "#88765f", "#71878b"];
export function ExpenseCategories({ rows, total }: { rows: Report["expenseCategories"]; total: number }) {
  return <section className={`${card} p-5`} aria-label="Kategori Pengeluaran">
    <h3 className="font-semibold">Kategori Pengeluaran</h3><p className="mt-1 text-xs text-[#62716a]">Pengeluaran operasional pada periode terpilih</p>
    {rows.length === 0 ? <p className="mt-4 rounded-xl bg-[#f7f9f7] p-5 text-sm text-[#62716a]">Belum ada pengeluaran pada periode ini.</p> : <>
      <div className="relative mx-auto my-4 h-40 w-40 rounded-full" role="img" aria-label={`Total pengeluaran ${money(total)}. Rincian kategori tersedia di bawah.`} style={{ background: `conic-gradient(${rows.map((row, i) => `${categoryColors[i % categoryColors.length]} ${row.start}% ${row.end}%`).join(", ")})` }}>
        <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white px-2 text-center"><span className="text-xs text-[#62716a]">Total Pengeluaran</span><span className="mt-1 max-w-full break-words text-sm font-semibold tabular-nums">{money(total)}</span></div>
      </div>
      <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">{rows.map((row, i) => <li key={row.category} className="flex items-center gap-2 border-t border-[#edf0ed] py-3 text-sm"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: categoryColors[i % categoryColors.length] }} /><span className="min-w-0 flex-1 break-words">{row.category}</span><span className="text-right tabular-nums"><span className="block font-medium">{money(row.amount)}</span><span className="text-xs text-[#62716a]">{new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(row.percentage)}%</span></span></li>)}</ul>
    </>}
  </section>;
}

export function FinanceHistory({ period, source }: { period: PeriodInput; source: Source }) {
  const [filter, setFilter] = useState({ type: "ALL", search: "", page: 1 });
  const [result, setResult] = useState<Awaited<ReturnType<typeof financeHistoryAction>> | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const method = { ALL: "ALL", cashTotal: "CASH", edcTotal: "BCA_EDC", qrisTotal: "MIDTRANS_QRIS" }[source];
  const requestKey = JSON.stringify({ period, filter, method, retry });
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    financeHistoryAction(period, { ...filter, method }).then(data => {
      if (active && version === generation.current) { setResult(data); setLoadedKey(requestKey); }
    }).catch(() => {
      if (active && version === generation.current) { setResult({ success: false, error: "Riwayat belum dapat dimuat. Periksa koneksi.", retryable: true }); setLoadedKey(requestKey); }
    });
    return () => { active = false; };
  }, [period, filter, method, retry, requestKey]);
  const current = loadedKey === requestKey ? result : null;
  const data = current?.success ? current.data : null;
  return <section className={`${card} min-w-0 p-5`} aria-label="Riwayat Transaksi">
    <h3 className="font-semibold">Riwayat Transaksi</h3>
    <div role="group" aria-label="Jenis transaksi" className="mt-3 flex flex-wrap gap-1 border-b border-[#edf0ed] pb-2">{[["ALL", "Semua"], ["INCOME", "Pemasukan"], ["EXPENSE", "Pengeluaran"]].map(([type, label]) => <button key={type} type="button" aria-pressed={filter.type === type} className={`${compactControl} ${filter.type === type ? "bg-[#e7f3ed] text-[#24634d]" : "text-[#62716a]"}`} onClick={() => setFilter({ ...filter, type, page: 1 })}>{label}</button>)}</div>
    <label className="mt-3 block text-xs text-[#62716a]">Cari nomor pesanan, deskripsi atau kategori pengeluaran<input type="search" maxLength={200} value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value, page: 1 })} className="mt-2 min-h-11 w-full rounded-lg border border-[#dfe5e1] bg-[#f9faf9] px-3 text-sm text-[#23382e]" placeholder="Cari transaksi…" /></label>
    {!current && <p role="status" className="py-8 text-center text-sm text-[#62716a]">Memuat riwayat…</p>}
    {current && !current.success && <div role="alert" className="py-4 text-sm"><p>{current.error}</p><button className={`${compactControl} mt-2 border border-[#dfe5e1]`} onClick={() => setRetry(n => n + 1)}>Coba lagi</button></div>}
    {data && <>
      {data.rows.length === 0 ? <p className="py-8 text-center text-sm text-[#62716a]">Tidak ada transaksi yang sesuai dengan periode dan filter ini.</p> : <ul className="mt-2 divide-y divide-[#edf0ed]">{data.rows.map(row => <li key={row.id} className="flex items-start gap-3 py-4">
        <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${row.type === "INCOME" ? "bg-[#e7f3ed] text-[#24634d]" : "bg-[#fcf0e7] text-[#9a6031]"}`}>{row.type === "INCOME" ? "↙" : "↗"}</span>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap justify-between gap-x-4 gap-y-1"><p className="break-words text-sm font-semibold">{row.title}</p><p className={`ml-auto break-all text-right text-sm font-semibold tabular-nums ${row.type === "INCOME" ? "text-[#24634d]" : "text-[#9a6031]"}`}><span className="sr-only">{row.type === "INCOME" ? "Pemasukan " : "Pengeluaran "}</span>{row.type === "INCOME" ? "+" : "−"}{money(row.amount)}</p></div><p className="mt-1 break-words text-sm text-[#62716a]">{row.description}</p><div className="mt-2 flex flex-wrap items-center gap-2"><span className="rounded-md bg-[#f2f4f3] px-2 py-1 text-xs text-[#62716a]">{row.badge}</span><time dateTime={row.date} className="text-xs text-[#62716a]">{new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium" }).format(new Date(row.date))}</time></div></div>
      </li>)}</ul>}
      <nav aria-label="Halaman riwayat" className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf0ed] pt-3"><p className="text-xs text-[#62716a]">{data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} dari {data.total} transaksi</p><div className="flex flex-wrap gap-1"><button disabled={data.page <= 1} className={`${compactControl} disabled:opacity-40`} onClick={() => setFilter({ ...filter, page: data.page - 1 })}>Sebelumnya</button>{Array.from({ length: Math.min(3, data.pages) }, (_, i) => Math.min(Math.max(1, data.page - 1), Math.max(1, data.pages - 2)) + i).map(page => <button key={page} aria-current={page === data.page ? "page" : undefined} className={`${compactControl} ${page === data.page ? "bg-[#e7f3ed] text-[#24634d]" : ""}`} onClick={() => setFilter({ ...filter, page })}>{page}</button>)}<button disabled={data.page >= data.pages} className={`${compactControl} disabled:opacity-40`} onClick={() => setFilter({ ...filter, page: data.page + 1 })}>Berikutnya</button></div></nav>
    </>}
  </section>;
}

export function FinanceReportPanel({ mode, initialValue }: { mode: "dashboard" | "monthly" | "yearly"; initialValue?: string }) {
  const [period, setPeriod] = useState<PeriodInput>(() => mode === "dashboard" ? defaultPeriod() : { type: mode === "monthly" ? "MONTH" : "YEAR", value: initialValue ?? jakartaBusinessDate().slice(0, mode === "monthly" ? 7 : 4) });
  const [result, setResult] = useState<Result | null>(null), [retry, setRetry] = useState(0);
  const [source, setSource] = useState<Source>("ALL");
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    financeReportAction(period).then(r => { if (active && version === generation.current) setResult(r); }).catch(() => { if (active && version === generation.current) setResult({ success: false, error: "Laporan belum dapat dimuat. Periksa koneksi." }); });
    return () => { active = false; };
  }, [period, retry]);
  function change(p: PeriodInput) { generation.current++; setResult(null); setPeriod(p); }
  const report = result?.success ? result.data : null;
  const s = report?.summary;
  if (mode === "dashboard") {
    const metrics = s && report ? [
      { label: "Pendapatan Bersih", value: s.netIncome, hint: s.netIncome === null ? "HPP belum lengkap" : "Setelah beban dan pengeluaran operasional", badge: "Rp", color: "bg-[#e7f3ed] text-[#24634d]" },
      { label: "Nilai Stok Bahan", value: report.inventory.amount, hint: "Saat ini · Di luar filter periode", badge: "▦", color: "bg-[#edf0fc] text-[#5d68a6]" },
      { label: "Total Pemasukan", value: s.paidSales, hint: "Total penjualan bruto pada periode ini", badge: "↙", color: "bg-[#e9f4f7] text-[#3b7c92]" },
      { label: "Total Pengeluaran", value: s.operatingExpenses, hint: "Pengeluaran operasional yang dicatat Finance", badge: "↗", color: "bg-[#fcf0e7] text-[#9a6031]" },
    ] : [];
    return <section className="space-y-4 text-[#23382e]">
      <header><h1 className="text-2xl font-semibold tracking-tight">Dashboard Keuangan</h1><p className="mt-2 text-sm text-[#62716a]">{periodLabel(period)} · WIB</p></header>
      <div className={`${card} space-y-4 p-4 sm:p-5`}>
        <PeriodControls period={period} onChange={change} compact />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#edf0ed] pt-3">
          <span className="text-sm text-[#62716a]">Metode Penjualan</span>
          <div role="group" aria-label="Metode Penjualan" className="flex flex-wrap gap-2">{Object.entries(sources).map(([key, label]) => <button key={key} type="button" aria-pressed={source === key} className={`${compactControl} border ${source === key ? "border-[#24634d] bg-[#24634d] text-white" : "border-[#e2e7e3] bg-white text-[#62716a] hover:bg-[#f2f6f3]"} rounded-full`} onClick={() => setSource(key as Source)}>{label}</button>)}</div>
          <p className="basis-full text-xs leading-5 text-[#62716a]">Metode berlaku untuk pemasukan pada tren, rincian pembayaran dan riwayat. Ringkasan dan pengeluaran mencakup semua metode.</p>
        </div>
      </div>
      {!result && <div role="status" className={`${card} p-8 text-center text-sm text-[#62716a]`}>Memuat laporan…</div>}
      {result && !result.success && <div role="alert" className="rounded-2xl border border-[#edd9cd] bg-[#fff8f2] p-6"><p>{result.error}</p><button type="button" className={`${compactControl} mt-4 border border-[#bf9277] bg-white`} onClick={() => { setResult(null); setRetry(n => n + 1); }}>Coba lagi</button></div>}
      {s && report && <>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(metric => <div key={metric.label} className={`${card} min-w-0 p-5`}>
          <dt className="flex items-center justify-between gap-2 text-sm font-medium text-[#62716a]">{metric.label}<span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-base ${metric.color}`}>{metric.badge}</span></dt>
          <dd className="mt-3 break-words text-xl xl:text-2xl font-semibold tracking-tight tabular-nums">{money(metric.value)}</dd>
          <dd className="mt-2 text-xs leading-5 text-[#62716a]">{metric.hint}</dd>
        </div>)}</dl>
        {s.paidOrderCount === 0 && s.operatingExpenses === 0 && <p className="rounded-xl border border-[#e2e7e3] bg-white p-4 text-sm text-[#62716a]">Belum ada transaksi atau pengeluaran pada periode ini.</p>}
        {(s.netIncome === null || report.inventory.missing > 0) && <div className="space-y-2 rounded-xl border border-[#ebdec1] bg-[#fffbef] p-4 text-sm leading-6 text-[#786039]">
          {s.netIncome === null && <p>HPP belum lengkap. HPP, profit dan pendapatan bersih yang belum tersedia ditampilkan sebagai -.</p>}
          {report.inventory.missing > 0 && <p>Valuasi belum lengkap: {report.inventory.missing} bahan dengan stok positif belum memiliki biaya. Nilai Stok Bahan ditampilkan sebagai -.</p>}
        </div>}
        <div className="grid items-start gap-4">
          <FinanceTrend rows={report.breakdown} source={source} period={period} />
          <ExpenseCategories rows={report.expenseCategories} total={s.operatingExpenses} />
          <section aria-label="Rincian pembayaran" className={`${card} min-w-0 p-5 sm:p-6`}>
            <h3 className="font-semibold">Rincian Pembayaran</h3><p className="mt-1 text-sm text-[#62716a]">Penjualan bruto · {sources[source]}</p>
            <dl className="mt-2 grid gap-x-6 sm:grid-cols-3">{(["cashTotal", "edcTotal", "qrisTotal"] as const).filter(key => source === "ALL" || source === key).map(key => <div key={key} className="flex flex-wrap items-center justify-between gap-2 py-4"><dt className="text-sm text-[#62716a]">{sources[key]}</dt><dd className="font-semibold tabular-nums">{money(s[key])}</dd></div>)}</dl>
            <div className="mt-2 flex items-center gap-3 border-t border-[#edf0ed] pt-3"><p className="text-xs text-[#62716a]">Jumlah Transaksi · Semua metode</p><p className="text-base font-semibold tabular-nums">{s.paidOrderCount}<span className="ml-2 text-xs font-normal text-[#62716a]">transaksi</span></p></div>
          </section>
        </div>
        <FinanceHistory key={`${period.type}-${period.value}`} period={period} source={source} />
        <aside className="text-xs leading-6 text-[#62716a]">
          <p><span className="font-medium">Saat ini:</span> nilai stok merupakan snapshot terkini, bukan nilai historis periode terpilih.</p>
          <p>Pengeluaran operasional tidak termasuk biaya yang sudah dicatat dalam HPP, potongan channel atau iklan. Pendapatan Bersih = sales Net Revenue − pengeluaran operasional.</p>
        </aside>
      </>}
      <nav aria-label="Laporan keuangan" className="flex flex-wrap gap-2 border-t border-[#e2e7e3] pt-4">{[["/admin/reports", "Laporan Harian"], ["/finance/reports/monthly", "Laporan Bulanan"], ["/finance/reports/yearly", "Laporan Tahunan"], ["/finance/expenses", "Pengeluaran"]].map(([href, label]) => <Link key={href} href={href} className={`${compactControl} text-[#24634d] hover:bg-[#e8efea]`}>{label}<span aria-hidden="true" className="ml-3">↗</span></Link>)}</nav>
    </section>;
  }
  const cards: [string, number | null][] = s ? [["Total Penjualan", s.paidSales], ["HPP", s.hpp], ["Gross Profit", s.grossProfit], ["Potongan/Beban Penjualan", s.salesDeductions], ["Pengeluaran Operasional", s.operatingExpenses], ["Pendapatan Bersih", s.netIncome]] : [];
  return <section className="space-y-6">
    <h2 className="text-3xl font-semibold">{mode === "monthly" ? "Laporan Bulanan" : "Laporan Tahunan"}</h2>
    <PeriodControls period={period} onChange={change} fixed />
    {!result && <p role="status">Memuat laporan…</p>}
    {result && !result.success && <div role="alert"><p>{result.error}</p><button className={control} onClick={() => { setResult(null); setRetry(n => n + 1); }}>Coba lagi</button></div>}
    {s && report && <>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([label, value]) => <div key={label} className="min-w-0 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-6"><dt>{label}</dt><dd className="mt-3 break-words text-3xl font-semibold tabular-nums">{money(value)}</dd></div>)}<div className="rounded-xl border border-[#dedfd5] bg-[#fffefa] p-6"><dt>Jumlah Transaksi</dt><dd className="mt-3 text-3xl font-semibold">{s.paidOrderCount}</dd></div></dl>
      <dl className="grid gap-4 sm:grid-cols-3">{([["Tunai", s.cashTotal], ["BCA EDC", s.edcTotal], ["QRIS", s.qrisTotal]] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-white p-5"><dt>{label}</dt><dd className="mt-2 text-2xl font-semibold">{money(value)}</dd></div>)}</dl>
      {s.paidOrderCount === 0 && s.operatingExpenses === 0 && <p>Belum ada transaksi atau pengeluaran pada periode ini.</p>}
      {s.netIncome === null && <p>HPP belum lengkap. HPP, profit dan pendapatan bersih yang belum tersedia ditampilkan sebagai -.</p>}
      <p className="text-sm">Pengeluaran operasional tidak termasuk biaya yang sudah dicatat dalam HPP, potongan channel atau iklan. Pendapatan Bersih = sales Net Revenue − pengeluaran operasional.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{[mode === "monthly" ? "Tanggal" : "Bulan", "Jumlah Transaksi", "Total Penjualan", "Tunai", "BCA EDC", "QRIS", "HPP", "Gross Profit", "Pengeluaran", "Pendapatan Bersih"].map(label => <th key={label} className="whitespace-nowrap p-3">{label}</th>)}</tr></thead><tbody>{report.breakdown.map(row => <tr key={row.key} className="border-t border-[#dedfd5]"><td className="p-3"><Link className="inline-flex min-h-14 items-center underline" href={mode === "monthly" ? `/admin/reports?date=${row.key}` : `/finance/reports/monthly?month=${row.key}`}>{row.key}</Link></td><td className="p-3">{row.paidOrderCount}</td>{[row.paidSales, row.cashTotal, row.edcTotal, row.qrisTotal, row.hpp, row.grossProfit, row.operatingExpenses, row.netIncome].map((n, i) => <td key={i} className="whitespace-nowrap p-3 tabular-nums">{money(n)}</td>)}</tr>)}</tbody></table></div>
    </>}
  </section>;
}
