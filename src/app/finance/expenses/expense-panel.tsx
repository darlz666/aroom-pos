"use client";
import { useEffect, useRef, useState } from "react";
import { expenseListAction, expenseSaveAction } from "@/lib/finance/actions";
import { categories, defaultPeriod, expenseInput, type PeriodInput } from "@/lib/finance/domain";
import { jakartaBusinessDate } from "@/lib/reports/domain";
import { control, money, PeriodControls } from "../report-panel";

type Result = Awaited<ReturnType<typeof expenseListAction>> | { success: false; error: string };
type Row = Extract<Result, { success: true }>["data"]["rows"][number];
type Intent = { operation: "CREATE" | "EDIT" | "DELETE"; id: string; key: string; revision: number; date?: string; category?: string; description?: string; amount?: number; note?: string };
export function ExpensePanel({ actorId }: { actorId: string }) {
  const [period, setPeriod] = useState<PeriodInput>(defaultPeriod), [search, setSearch] = useState(""), [category, setCategory] = useState(""), [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Row | "new" | null>(null), [intent, setIntent] = useState<Intent | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  const generation = useRef(0), inFlight = useRef(false);
  const storageKey = `finance-expense-pending:${actorId}`;
  // Hydrate browser-only recovery state after SSR; writes stay disabled until read.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { try { const saved = sessionStorage.getItem(storageKey); if (saved) { const pending = JSON.parse(saved); expenseInput(pending); setIntent(pending); setMessage("Ada permintaan yang belum dipastikan. Ulangi permintaan yang sama untuk memeriksa hasil."); } setReady(true); } catch { setMessage("Permintaan tersimpan tidak dapat dibaca. Periksa riwayat sebelum menambah pengeluaran."); } }, [storageKey]);
  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    expenseListAction(period, search, category, page).then(r => { if (active && version === generation.current) setResult(r); }).catch(() => { if (active && version === generation.current) setResult({ success: false, error: "Pengeluaran belum dapat dimuat." }); });
    return () => { active = false; };
  }, [period, search, category, page, reload]);
  function clear() { generation.current++; setResult(null); }
  async function submit(request: Intent) {
    if (inFlight.current || !ready) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Pengeluaran belum dikirim."); return; }
    try { expenseInput(request); sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setMessage("Periksa isian dan penyimpanan browser sebelum mengirim."); return; }
    inFlight.current = true; setBusy(true); setIntent(request); setMessage("");
    try {
      const response = await expenseSaveAction(request);
      if (!response.success) {
        if (!response.retryable) { sessionStorage.removeItem(storageKey); setIntent(null); setMessage(response.error); clear(); setReload(n => n + 1); }
        else setMessage(`${response.error} Permintaan dikunci; coba lagi dengan permintaan yang sama atau muat ulang riwayat.`);
        return;
      }
      sessionStorage.removeItem(storageKey); setIntent(null); setEditing(null); clear(); setReload(n => n + 1); setMessage("Pengeluaran tersimpan.");
    } catch { setMessage("Hasil belum pasti. Jangan buat ulang pengeluaran; ulangi permintaan yang sama."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const row = editing && editing !== "new" ? editing : null;
  return <section className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><h1 className="text-3xl font-semibold">Pengeluaran</h1><button className={control} disabled={!ready || busy || !!intent} onClick={() => { setEditing("new"); setMessage(""); }}>Tambah Pengeluaran</button></div>
    <p>Catat biaya operasional yang belum masuk HPP, potongan channel atau iklan. Jangan mencatat ulang pembelian bahan yang sudah diperhitungkan dalam HPP.</p>
    <PeriodControls period={period} onChange={p => { clear(); setPeriod(p); setPage(1); }} />
    <div className="flex flex-wrap gap-3"><label className="grid gap-2">Cari deskripsi/kategori<input className={control} maxLength={200} value={search} onChange={e => { clear(); setSearch(e.target.value); setPage(1); }} /></label><label className="grid gap-2">Kategori<select className={control} value={category} onChange={e => { clear(); setCategory(e.target.value); setPage(1); }}><option value="">Semua kategori</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label></div>
    {message && <p role="status">{message}</p>}
    {intent && <div className="flex flex-wrap gap-3"><button className={control} disabled={busy} onClick={() => void submit(intent)}>{busy ? "Menyimpan…" : "Ulangi permintaan yang sama"}</button><button className={control} disabled={busy} onClick={() => { clear(); setReload(n => n + 1); }}>Muat ulang riwayat</button><p>Isian dikunci sampai hasil permintaan dipastikan.</p></div>}
    {editing && <form key={row?.id ?? "new"} className="grid gap-4 rounded-xl border bg-white p-6 sm:grid-cols-2" onSubmit={event => {
      event.preventDefault(); if (busy || intent) return;
      const form = new FormData(event.currentTarget), amount = String(form.get("amount"));
      if (!/^[1-9]\d*$/.test(amount) || !Number.isSafeInteger(Number(amount)) || Number(amount) > 2147483647) { setMessage("Nominal harus rupiah bulat positif tanpa pemisah, contoh 25000."); return; }
      void submit({ operation: row ? "EDIT" : "CREATE", id: row?.id ?? crypto.randomUUID(), key: crypto.randomUUID(), revision: row?.revision ?? 0,
        date: String(form.get("date")), category: String(form.get("category")), description: String(form.get("description")), amount: Number(amount), note: String(form.get("note")) });
    }}>
      <fieldset disabled={busy || !!intent} className="contents">
        <legend className="text-xl font-semibold">{row ? "Edit Pengeluaran" : "Tambah Pengeluaran"}</legend>
        <label className="grid gap-2">Tanggal<input className={control} name="date" type="date" required defaultValue={row?.occurredAt ?? jakartaBusinessDate()} /></label>
        <label className="grid gap-2">Kategori<select className={control} name="category" defaultValue={row?.category ?? categories[0]}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="grid gap-2">Deskripsi<input className={control} name="description" required maxLength={200} defaultValue={row?.description ?? ""} /></label>
        <label className="grid gap-2">Nominal (IDR tanpa pemisah)<input className={control} name="amount" inputMode="numeric" pattern="[1-9][0-9]*" required defaultValue={row?.amount ?? ""} /></label>
        <label className="grid gap-2 sm:col-span-2">Catatan (opsional)<textarea className={control} name="note" maxLength={1000} defaultValue={row?.note ?? ""} /></label>
        <button className={control} type="submit">Simpan Pengeluaran</button><button className={control} type="button" onClick={() => setEditing(null)}>Batal</button>
      </fieldset>
    </form>}
    {!result && <p role="status">Memuat pengeluaran…</p>}
    {result && !result.success && <div role="alert">{result.error}<button className={control} onClick={() => { clear(); setReload(n => n + 1); }}>Coba lagi</button></div>}
    {result?.success && <>
      {result.data.rows.length === 0 && <p>Belum ada pengeluaran untuk filter ini.</p>}
      <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{["Tanggal", "Kategori", "Deskripsi", "Nominal", "Dibuat", "Aksi"].map(h => <th className="p-3" key={h}>{h}</th>)}</tr></thead><tbody>{result.data.rows.map(expense => <tr key={expense.id} className="border-t"><td className="whitespace-nowrap p-3">{expense.occurredAt}</td><td className="p-3"><span className="rounded-full bg-[#e9eade] px-3 py-1 text-sm">{expense.category}</span></td><td className="p-3">{expense.description}{expense.note && <p className="text-sm text-[#62685c]">{expense.note}</p>}</td><td className="whitespace-nowrap p-3 text-xl tabular-nums">{money(expense.amount)}</td><td className="p-3">{new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium" }).format(new Date(expense.createdAt))}</td><td className="p-3"><div className="flex gap-2"><button disabled={busy || !!intent} className={control} onClick={() => setEditing(expense)}>Edit</button><button disabled={busy || !!intent} className={control} onClick={() => { if (window.confirm(`Batalkan pengeluaran ${expense.description}? Catatan tetap disimpan untuk audit.`)) void submit({ operation: "DELETE", id: expense.id, revision: expense.revision, key: crypto.randomUUID() }); }}>Batalkan</button></div></td></tr>)}</tbody></table></div>
      <div className="flex items-center gap-3"><button className={control} disabled={page === 1} onClick={() => { clear(); setPage(p => p - 1); }}>Sebelumnya</button><span>Halaman {page}</span><button className={control} disabled={!result.data.hasMore} onClick={() => { clear(); setPage(p => p + 1); }}>Berikutnya</button></div>
    </>}
  </section>;
}
