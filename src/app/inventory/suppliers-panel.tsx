"use client";

import { useRef, useState, type FormEvent } from "react";
import { createSupplierAction, updateSupplierAction } from "@/lib/inventory/actions";
import { card, control, inputError, primary, readError, type SupplierRow, type SuppliersResult } from "./presentation";

const blank = { name: "", contact: "", phone: "", address: "", active: true };
export function SuppliersPanel({ result, loading, reload, onWriting, onSaved }: {
  result: SuppliersResult; loading: boolean; reload: () => Promise<void>; onWriting: (busy: boolean) => void; onSaved: (supplier: SupplierRow) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const locked = busy || loading || needsReload || !result.success;
  const uncertain = "Status supplier belum pasti. Muat ulang daftar dan periksa hasil sebelum mengirim perubahan lain.";

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onWriting(true);
    try { await reload(); setNeedsReload(false); setEditing(null); setFields(blank); setError(""); setNotice(""); }
    finally { inFlight.current = false; setBusy(false); onWriting(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || locked) return;
    if (!navigator.onLine) { setError("Tidak ada koneksi. Sambungkan internet sebelum menyimpan supplier."); return; }
    inFlight.current = true; setBusy(true); onWriting(true); setError(""); setNotice("");
    try {
      const response = editing ? await updateSupplierAction({ supplierId: editing, ...fields }) : await createSupplierAction(fields);
      if (!response.success) {
        if (response.code === "UNAVAILABLE") { setNeedsReload(true); setError(uncertain); }
        else setError(inputError(response.code));
        return;
      }
      onSaved(response.supplier); setEditing(null); setFields(blank); setNotice("Supplier disimpan.");
    } catch { setNeedsReload(true); setError(uncertain); }
    finally { inFlight.current = false; setBusy(false); onWriting(false); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-2xl font-semibold">Supplier</h2><button type="button" className={control} disabled={busy || loading} onClick={refresh}>Muat ulang supplier</button></div>
    {(error || !result.success) && <p role="alert" className="text-[#8b3026]">{error || readError}</p>}
    <p role="status">{busy ? "Menyimpan / memuat supplier…" : notice}</p>
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <form onSubmit={save} className={card}>
        <h3 className="mb-4 text-xl font-semibold">{editing ? "Edit supplier" : "Tambah supplier"}</h3>
        <fieldset disabled={locked} className="grid gap-4">
          {([["name", "Nama supplier", 128], ["contact", "Nama kontak", 128], ["phone", "Telepon", 64], ["address", "Alamat", 1000]] as const).map(([key, label, max]) =>
            <label key={key} className="grid gap-2">{label}<input name={key} className={control} value={fields[key]} maxLength={max} required={key === "name"} type={key === "phone" ? "tel" : "text"} onChange={e => setFields(current => ({ ...current, [key]: e.target.value }))} /></label>)}
          <label className="grid gap-2">Status supplier<select className={control} value={String(fields.active)} onChange={e => setFields(current => ({ ...current, active: e.target.value === "true" }))}><option value="true">Aktif</option><option value="false">Nonaktif</option></select></label>
          <div className="flex flex-wrap gap-3"><button type="submit" className={primary}>Simpan supplier</button>{editing && <button type="button" className={control} onClick={() => { setEditing(null); setFields(blank); setError(""); }}>Batal edit</button>}</div>
        </fieldset>
      </form>
      <div className="space-y-3" aria-label="Daftar supplier" aria-busy={loading}>
        {loading ? <p role="status">Memuat daftar…</p> : result.success && <>
          {!result.suppliers.length && <p>Belum ada supplier. Tambahkan supplier pertama untuk menerima stok.</p>}
          {result.suppliers.map(supplier => <article key={supplier.id} className={card}><div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 break-words"><h3 className="text-xl font-semibold">{supplier.name}</h3><p>{supplier.active ? "Aktif" : "Nonaktif"}</p></div>
            <button type="button" className={control} disabled={locked} onClick={() => {
              setEditing(supplier.id); setFields({ name: supplier.name, contact: supplier.contact ?? "", phone: supplier.phone ?? "", address: supplier.address ?? "", active: supplier.active }); setError(""); setNotice("");
            }}>Edit {supplier.name}</button></div>
            <p className="mt-2 break-words">{supplier.contact || "Kontak belum diisi"}{supplier.phone ? ` · ${supplier.phone}` : ""}</p><p className="break-words">{supplier.address}</p>
          </article>)}
        </>}
      </div>
    </div>
  </div>;
}
