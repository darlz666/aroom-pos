"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createStockInAction } from "@/lib/inventory/actions";
import { compatibleUnits, receivingSubmission, restoreSubmission, type ReceivingLine, type ReceivingSubmission } from "@/lib/inventory/receiving-form";
import { card, control, inputError, jakartaInput, primary, quantity, readError, rupiah, type IngredientsResult, type SuppliersResult } from "./presentation";

const emptyLine = (): ReceivingLine => ({ ingredientId: "", quantity: "", unit: "pcs", unitCost: "" });
const uncertainMessage = "Status penerimaan belum pasti. Isian dikunci agar stok tidak tercatat dua kali. Gunakan Periksa / coba lagi untuk memulihkan penerimaan yang sama.";
type Saved = Extract<Awaited<ReturnType<typeof createStockInAction>>, { success: true }>["stockIn"];

export function StockInForm({ actorId, ingredients, suppliers, loading, reload, onSaved, onHistory }: {
  actorId: string; ingredients: IngredientsResult; suppliers: SuppliersResult; loading: boolean; reload: () => Promise<void>;
  onSaved: () => void; onHistory: () => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ReceivingLine[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<ReceivingSubmission | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false), completed = useRef(false), submission = useRef<ReceivingSubmission | null>(null);
  const storageKey = `aroom.stock-in.pending.${actorId}`;
  const available = ingredients.success ? ingredients.ingredients : [];
  const activeSuppliers = suppliers.success ? suppliers.suppliers.filter(row => row.active) : [];
  const locked = busy || !!pending || !!saved || !ready || loading || !ingredients.success || !suppliers.success;

  useEffect(() => {
    async function restore() {
      try {
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
          const request = restoreSubmission(stored);
          submission.current = request; setPending(request); setSupplierId(request.supplierId); setNotes(request.notes);
          setReceivedAt(jakartaInput(new Date(request.receivedAt)));
          setLines(request.items.map(item => ({ ...item, unitCost: String(item.unitCost) })));
          setError(uncertainMessage);
        } else setReceivedAt(jakartaInput());
        setReady(true);
      } catch { setError("Data pemulihan tidak dapat dibaca. Jangan membuat penerimaan pengganti; periksa riwayat bersama Admin."); }
    }
    void restore();
    const warn = (event: BeforeUnloadEvent) => { if (submission.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [storageKey]);

  function changeLine(index: number, patch: Partial<ReceivingLine>) {
    if (submission.current || inFlight.current) return;
    setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  }
  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (inFlight.current || completed.current || saved || !ready || (!submission.current && locked)) return;
    if (!navigator.onLine) { setError("Tidak ada koneksi. Sambungkan internet lalu coba lagi. Penerimaan tidak dikirim otomatis."); return; }
    const recovering = !!submission.current;
    let request: ReceivingSubmission;
    try { request = submission.current ?? receivingSubmission({ supplierId, receivedAt, notes, lines }, crypto.randomUUID()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Periksa isian penerimaan."); return; }
    // Save original intent BEFORE transport. Reload recovery is explicit, never
    // an offline queue or an automatic resubmission. It is scoped to this actor/tab.
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError("Penyimpanan pemulihan tidak tersedia. Aktifkan penyimpanan browser sebelum mengirim penerimaan."); return; }
    submission.current = request; setPending(request); inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await createStockInAction(request);
      if (!result.success) {
        if (recovering || result.code === "UNAVAILABLE" || result.code === "IDEMPOTENCY_CONFLICT") {
          setError(result.code === "IDEMPOTENCY_CONFLICT" ? inputError(result.code) : result.code === "UNAVAILABLE" ? uncertainMessage : `${uncertainMessage} ${inputError(result.code)}`);
        } else {
          sessionStorage.removeItem(storageKey); submission.current = null; setPending(null); setError(inputError(result.code));
        }
        return;
      }
      sessionStorage.removeItem(storageKey); submission.current = null; completed.current = true; setPending(null); setSaved(result.stockIn); onSaved();
    } catch { setError(uncertainMessage); }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-2xl font-semibold">Penerimaan stok</h2>
      <button type="button" className={control} disabled={busy || !!pending || loading} onClick={reload}>Muat ulang pilihan</button></div>
    {error && <p role="alert" className="text-[#8b3026]">{error}</p>}
    {(!ingredients.success || !suppliers.success) && <p role="alert">{readError}</p>}
    <p role="status">{busy ? "Memastikan penerimaan tersimpan…" : loading ? "Memuat pilihan…" : ""}</p>
    {saved ? <section className={card} aria-label="Penerimaan tersimpan">
      <h3 className="text-2xl font-semibold">Penerimaan tersimpan</h3><p className="mt-2 break-all">{saved.referenceNumber}</p><p>{saved.supplierName}</p>
      {saved.items.map(item => <p key={item.id} className="mt-3 break-words">{item.ingredientName}: +{quantity(item.baseQuantity)} {item.baseUnit} · {rupiah(item.lineTotal)}</p>)}
      <div className="mt-5 flex flex-wrap gap-3"><button type="button" className={control} onClick={onHistory}>Lihat riwayat</button><button type="button" className={primary} onClick={() => {
        completed.current = false; setSaved(null); setLines([emptyLine()]); setNotes(""); setReceivedAt(jakartaInput()); setError("");
      }}>Penerimaan baru</button></div>
    </section> : <form onSubmit={send} className="space-y-5">
      <fieldset disabled={locked} className={`${card} grid gap-4 md:grid-cols-2`}>
        <label className="grid gap-2">Supplier<select className={control} value={supplierId} onChange={e => setSupplierId(e.target.value)} required><option value="">Pilih supplier aktif</option>
          {activeSuppliers.map(row => <option key={row.id} value={row.id}>{row.name}{row.phone ? ` · ${row.phone}` : ""}</option>)}</select></label>
        <label className="grid gap-2">Diterima pada (WIB)<input className={control} type="datetime-local" value={receivedAt} onChange={e => setReceivedAt(e.target.value)} required /></label>
        <label className="grid gap-2 md:col-span-2">Catatan (opsional)<textarea className={control} maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      </fieldset>
      {!loading && suppliers.success && !activeSuppliers.length && <p>Belum ada supplier aktif. Tambahkan atau aktifkan supplier melalui tab Supplier.</p>}
      {!loading && ingredients.success && !available.length && <p>Belum ada bahan aktif untuk diterima. Hubungi Admin untuk menyiapkan data bahan.</p>}
      <p>Jumlah tanpa pemisah ribuan, maksimal 3 desimal. Biaya dalam rupiah per satuan dasar: ml, g, atau pcs.</p>
      {lines.map((line, index) => {
        const ingredient = available.find(row => row.id === line.ingredientId);
        return <fieldset disabled={locked} key={index} className={`${card} grid gap-4 md:grid-cols-2 xl:grid-cols-5`}>
          <legend className="px-2 font-semibold">Bahan {index + 1}</legend>
          <label className="grid gap-2 xl:col-span-2">Bahan<select className={control} value={line.ingredientId} required onChange={e => {
            const selected = available.find(row => row.id === e.target.value);
            changeLine(index, { ingredientId: e.target.value, unit: selected?.baseUnit ?? "pcs" });
          }}><option value="">Pilih bahan</option>{available.map(row => <option key={row.id} value={row.id} disabled={lines.some((other, i) => i !== index && other.ingredientId === row.id)}>{row.name} ({row.baseUnit})</option>)}</select></label>
          <label className="grid gap-2">Jumlah<input className={control} inputMode="decimal" value={line.quantity} required onChange={e => changeLine(index, { quantity: e.target.value })} /></label>
          <label className="grid gap-2">Satuan<select className={control} value={line.unit} onChange={e => changeLine(index, { unit: e.target.value })}>{compatibleUnits(ingredient?.baseUnit ?? "pcs").map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></label>
          <label className="grid gap-2">Biaya Rp / {ingredient?.baseUnit ?? "satuan dasar"}<input className={control} inputMode="numeric" value={line.unitCost} required onChange={e => changeLine(index, { unitCost: e.target.value })} /></label>
          <button type="button" className={`${control} justify-self-start`} disabled={lines.length === 1} onClick={() => { if (!submission.current && !inFlight.current) setLines(current => current.filter((_, i) => i !== index)); }}>Hapus bahan {index + 1}</button>
        </fieldset>;
      })}
      <div className="flex flex-wrap gap-3">
        <button type="button" className={control} disabled={locked || lines.length >= 100} onClick={() => { if (!submission.current && !inFlight.current) setLines(current => [...current, emptyLine()]); }}>Tambah bahan</button>
        <button type="submit" className={primary} disabled={locked || !available.length || !activeSuppliers.length}>Simpan penerimaan</button>
      </div>
      {pending && <div className={`${card} space-y-3`}><p>Penerimaan yang sama akan diperiksa; stok tidak ditambah ulang jika sudah tersimpan.</p>
        {pending.items.map((item, index) => <p key={item.ingredientId}>{ingredients.success ? ingredients.ingredients.find(row => row.id === item.ingredientId)?.name ?? `Bahan ${index + 1}` : `Bahan ${index + 1}`}: {quantity(item.quantity)} {item.unit} · {rupiah(item.unitCost)} / satuan dasar</p>)}
        <button type="button" className={primary} disabled={busy} onClick={() => send()}>Periksa / coba lagi</button>
        <button type="button" className={`${control} ml-3`} onClick={onHistory}>Periksa riwayat</button></div>}
    </form>}
  </div>;
}
