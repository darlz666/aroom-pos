"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { categoryHistoryAction, listCategoriesAction, saveCategoryAction } from "@/lib/categories/actions";
import { categoryInput, type CategoryRequest, type CategoryRow } from "@/lib/categories/domain";

const control = "min-h-14 rounded-lg border border-[#a8aea0] px-4 py-3 disabled:opacity-50";
const blank = { id: null as string | null, expectedRevision: null as number | null, name: "", displayOrder: "0", active: true };
function snapshot(value: unknown) {
  if (!value || typeof value !== "object") return "Belum ada";
  const row = value as CategoryRow;
  return `${row.name} · Urutan ${row.displayOrder} · ${row.active ? "Aktif" : "Nonaktif"}`;
}
const errors: Record<string, string> = {
  DUPLICATE_NAME: "Nama kategori sudah digunakan, termasuk kategori nonaktif.",
  STALE_REVISION: "Kategori telah berubah. Muat ulang dan tinjau sebelum menyimpan.",
  INVALID_INPUT: "Periksa nama dan urutan kategori.", FORBIDDEN: "Akses ditolak.", NOT_FOUND: "Kategori tidak ditemukan.",
  IDEMPOTENCY_CONFLICT: "Permintaan tidak cocok. Hubungi Admin; jangan buat permintaan pengganti.",
};
export function CategoryWorkspace({ actorId, initial }: { actorId: string; initial: Awaited<ReturnType<typeof listCategoriesAction>> }) {
  const [result, setResult] = useState(initial);
  const [fields, setFields] = useState(blank);
  const [pending, setPending] = useState<CategoryRequest | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(!initial.success);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<Awaited<ReturnType<typeof categoryHistoryAction>> | null>(null);
  const [historyName, setHistoryName] = useState("");
  const writing = useRef(false), generation = useRef(0), historyGeneration = useRef(0);
  const unresolved = useRef<CategoryRequest | null>(null), mustRefresh = useRef(!initial.success);
  const storageKey = `aroom:category:${actorId}`;
  useEffect(() => {
    let mounted = true;
    const reads = generation, historyReads = historyGeneration;
    void Promise.resolve().then(() => {
      if (!mounted) return;
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) { unresolved.current = categoryInput(JSON.parse(raw)); setPending(unresolved.current); }
        setReady(true);
      } catch { setMessage("Penyimpanan pemulihan tidak tersedia atau rusak. Jangan kirim perubahan; hubungi Admin."); }
    });
    return () => { mounted = false; reads.current++; historyReads.current++; };
  }, [storageKey]);
  async function reload() {
    const version = ++generation.current;
    mustRefresh.current = true;
    setRefreshRequired(true);
    try {
      const value = await listCategoriesAction();
      if (version !== generation.current) return;
      setResult(value); setRefreshRequired(!value.success); mustRefresh.current = !value.success;
    } catch {
      if (version === generation.current) setResult({ success: false, code: "UNAVAILABLE" });
    }
  }
  async function send(request: CategoryRequest, recovery: boolean) {
    if (writing.current) return;
    if (unresolved.current && JSON.stringify(unresolved.current) !== JSON.stringify(request)) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Coba lagi saat online."); return; }
    writing.current = true; setBusy(true); setMessage("");
    try {
      // Persist before calling the server; a failed write must never send.
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      unresolved.current = request;
      setPending(request);
      let value: Awaited<ReturnType<typeof saveCategoryAction>>;
      try { value = await saveCategoryAction(request); }
      catch { setMessage("Hasil belum pasti. Pulihkan dengan permintaan yang sama."); return; }
      if (!value.success) {
        setMessage(errors[value.code] ?? "Hasil belum pasti. Pulihkan dengan permintaan yang sama.");
        if (!recovery && value.code !== "UNAVAILABLE" && value.code !== "IDEMPOTENCY_CONFLICT") {
          sessionStorage.removeItem(storageKey); unresolved.current = null; setPending(null);
          if (value.code === "STALE_REVISION") { setFields(blank); await reload(); }
        }
        return;
      }
      sessionStorage.removeItem(storageKey); unresolved.current = null; setPending(null); setFields(blank);
      setHistory(null); setHistoryName(""); historyGeneration.current++;
      setMessage("Kategori tersimpan. Data dimuat ulang dari server.");
      await reload();
    } catch { setReady(false); setMessage("Penyimpanan pemulihan gagal. Jangan kirim perubahan; hubungi Admin."); }
    finally { writing.current = false; setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || pending || refreshRequired || writing.current || unresolved.current || mustRefresh.current) return;
    try {
      if (!/^\d+$/.test(fields.displayOrder)) throw new Error();
      void send(categoryInput({ ...fields, displayOrder: Number(fields.displayOrder), key: crypto.randomUUID() }), false);
    } catch { setMessage(errors.INVALID_INPUT); }
  }
  function edit(row: CategoryRow) { setFields({ id: row.id, expectedRevision: row.revision, name: row.name, displayOrder: String(row.displayOrder), active: row.active }); }
  async function showHistory(row: CategoryRow) {
    const version = ++historyGeneration.current; setHistory(null); setHistoryName(row.name);
    try { const value = await categoryHistoryAction(row.id); if (version === historyGeneration.current) setHistory(value); }
    catch { if (version === historyGeneration.current) setHistory({ success: false, code: "UNAVAILABLE" }); }
  }
  const locked = !ready || busy || !!pending || refreshRequired;
  return <div className="space-y-6">
    <p>Kategori nonaktif tidak tampil di katalog POS. Produk dan riwayat transaksi tetap tersimpan.</p>
    {message && <p role="status">{message}</p>}
    {pending && <section className="space-y-3 rounded-xl border p-4" aria-label="Pemulihan kategori">
      <p>Permintaan belum diselesaikan: {pending.name}, urutan {pending.displayOrder}, {pending.active ? "aktif" : "nonaktif"}.</p>
      <button className={control} disabled={busy || !ready} onClick={() => void send(pending, true)}>Pulihkan permintaan</button>
    </section>}
    <form onSubmit={submit} className="space-y-4 rounded-xl border p-4">
      <h2 className="text-xl font-semibold">{fields.id ? "Ubah kategori" : "Kategori baru"}</h2>
      <fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2">Nama kategori<input required maxLength={128} value={fields.name} onChange={e => setFields({ ...fields, name: e.target.value })} className={control} /></label>
        <label className="grid gap-2">Urutan tampilan<input required inputMode="numeric" value={fields.displayOrder} onChange={e => setFields({ ...fields, displayOrder: e.target.value })} className={control} /></label>
        <label className="flex min-h-14 items-center gap-3"><input type="checkbox" checked={fields.active} onChange={e => setFields({ ...fields, active: e.target.checked })} />Aktif</label>
        <button type="submit" className={control}>{busy ? "Menyimpan..." : "Simpan kategori"}</button>
        {fields.id && <button type="button" className={control} onClick={() => setFields(blank)}>Batal ubah</button>}
      </fieldset>
    </form>
    <button className={control} disabled={busy} onClick={() => void reload()}>Muat ulang kategori</button>
    {!result.success ? <p role="alert">Kategori gagal dimuat. Coba muat ulang.</p> : <section className="grid gap-3 md:grid-cols-2" aria-label="Daftar kategori">
      {!result.categories.length && <p>Belum ada kategori. Buat kategori pertama tanpa data demo.</p>}
      {result.categories.map(row => <article key={row.id} className="min-w-0 space-y-3 rounded-xl border bg-white p-4">
        <h2 className="break-words text-xl font-semibold">{row.name}</h2><p>Urutan {row.displayOrder} · {row.active ? "Aktif" : "Nonaktif"}</p>
        <div className="flex flex-wrap gap-3"><button className={control} disabled={locked} onClick={() => edit(row)}>Ubah {row.name}</button>
          <button className={control} onClick={() => void showHistory(row)}>Riwayat {row.name}</button></div>
      </article>)}
    </section>}
    {historyName && <section className="space-y-3 rounded-xl border p-4" aria-label="Riwayat kategori">
      <h2 className="text-xl font-semibold">Riwayat {historyName} (50 terbaru)</h2>
      {!history ? <p>Memuat riwayat...</p> : !history.success ? <p role="alert">Riwayat gagal dimuat. Pilih kembali tombol riwayat.</p> : history.events.map(event =>
        <div key={event.id} className="break-words border-t pt-3"><p>{event.action === "CATEGORY_CREATED" ? "Dibuat" : event.action === "CATEGORY_UPDATED" ? "Diubah" : "Tidak berubah"} · {new Date(event.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB</p>
          <p>Pelaku: {event.actorId}</p><p>Sebelum: {snapshot(event.before)}</p><p>Sesudah: {snapshot(event.after)}</p></div>)}
    </section>}
  </div>;
}
