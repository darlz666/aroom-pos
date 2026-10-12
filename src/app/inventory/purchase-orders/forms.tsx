"use client";
import { useState } from "react";
import { priceIncreased } from "./form-input";
import { card, control, units, type Detail, type Intent, type Masters, type Receipts } from "./presentation";

type Props = { locked: boolean; masters: Masters; submit: (intent: Intent) => Promise<void> };
export function DraftForm({ detail, locked, masters, submit, cancel }: Props & { detail: Detail | null; cancel: () => void }) {
  const [lines, setLines] = useState(() => detail?.lines.map(l => ({ id: l.id, ingredientId: l.ingredientId ?? "", name: l.proposedName ?? "", base: l.baseUnit as string, quantity: l.purchaseQuantity, unit: l.purchaseUnit as string, price: String(l.estimatedUnitPrice) })) ?? []);
  function change(index: number, patch: Partial<typeof lines[number]>) { setLines(old => old.map((l, i) => i === index ? { ...l, ...patch } : l)); }
  return <form className={card} onSubmit={e => {
    e.preventDefault(); if (locked) return;
    const form = new FormData(e.currentTarget);
    void submit({ kind: "write", payload: { id: detail?.id ?? crypto.randomUUID(), key: crypto.randomUUID(), revision: detail?.revision ?? 0, operation: detail ? "EDIT" : "CREATE", data: {
      supplierId: String(form.get("supplier")), notes: String(form.get("notes") ?? "").trim(),
      lines: lines.map(l => ({ id: l.id, ...(l.ingredientId ? { ingredientId: l.ingredientId } : { proposedIngredient: { name: l.name.trim(), baseUnit: l.base } }), purchaseQuantity: l.quantity, purchaseUnit: l.unit, estimatedUnitPrice: Number(l.price) })),
    } } });
  }}><fieldset disabled={locked} className="min-w-0 space-y-5">
    <legend className="mb-4 text-xl font-semibold">{detail ? "Ubah draf PO" : "PO baru"}</legend>
    <label className="grid gap-2">Supplier<select className={control} name="supplier" defaultValue={detail?.supplierId ?? ""} required><option value="">Pilih supplier aktif</option>{masters.suppliers.filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    {lines.map((l, i) => <fieldset key={l.id} className="grid min-w-0 gap-3 rounded-lg border border-[#dce1d7] p-3 sm:grid-cols-2">
      <legend className="px-2 font-semibold">Bahan {i + 1}</legend>
      <label className="grid min-w-0 gap-2">Bahan<select className={control} value={l.ingredientId} onChange={e => { const m = masters.ingredients.find(m => m.id === e.target.value); change(i, { ingredientId: e.target.value, base: m?.baseUnit ?? "g", unit: m?.baseUnit ?? "g" }); }}><option value="">Usulkan bahan baru</option>{masters.ingredients.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name} ({m.baseUnit})</option>)}</select></label>
      {!l.ingredientId && <><label className="grid min-w-0 gap-2">Nama bahan usulan<input className={control} value={l.name} onChange={e => change(i, { name: e.target.value })} required maxLength={128} /></label><label className="grid min-w-0 gap-2">Satuan dasar<select className={control} value={l.base} onChange={e => change(i, { base: e.target.value, unit: e.target.value })}>{["g", "ml", "pcs"].map(u => <option key={u}>{u}</option>)}</select></label></>}
      <label className="grid min-w-0 gap-2">Jumlah pembelian<input className={control} value={l.quantity} onChange={e => change(i, { quantity: e.target.value })} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,3})?" required /></label>
      <label className="grid min-w-0 gap-2">Satuan pembelian<select className={control} value={l.unit} onChange={e => change(i, { unit: e.target.value })}>{units(l.base).map(u => <option key={u}>{u}</option>)}</select></label>
      <label className="grid min-w-0 gap-2">Estimasi harga per {l.unit} (Rp)<input className={control} value={l.price} onChange={e => change(i, { price: e.target.value })} inputMode="numeric" pattern="[0-9]+" required /></label>
      <button className={control} type="button" onClick={() => setLines(old => old.filter((_, n) => n !== i))}>Hapus bahan {i + 1}</button>
    </fieldset>)}
    <button className={control} type="button" disabled={lines.length >= 100} onClick={() => setLines(old => [...old, { id: crypto.randomUUID(), ingredientId: "", name: "", base: "g", quantity: "", unit: "g", price: "" }])}>Tambah bahan</button>
    <label className="grid gap-2">Catatan (opsional)<input name="notes" className={control} defaultValue={detail?.notes ?? ""} maxLength={2000} /></label>
    <p className="text-sm text-[#62685c]">Gunakan titik untuk desimal jumlah (maksimal 3 angka). Harga dalam rupiah utuh tanpa pemisah. Total dihitung server setelah disimpan. Usulan bahan baru dibuat hanya saat penerimaan.</p>
    <div className="flex flex-wrap gap-3"><button className={control} disabled={!lines.length}>Simpan draf</button><button className={control} type="button" onClick={cancel}>Tutup formulir</button></div>
  </fieldset></form>;
}

export function ReceiveForm({ detail, receipts, locked, masters, submit }: Props & { detail: Detail; receipts: Receipts }) {
  const [selection, setSelection] = useState<Record<string, { selected: boolean; unit: string; price: string; resolution: string }>>({});
  return <form className={card} onSubmit={e => {
    e.preventDefault(); if (locked) return;
    const form = new FormData(e.currentTarget);
    const lines = detail.lines.filter(l => selection[l.id]?.selected).map(l => {
      const s = selection[l.id], progress = receipts.lines.find(p => p.lineId === l.id)!;
      return { lineId: l.id, quantity: String(form.get(`quantity:${l.id}`)), unit: s.unit, purchaseUnitCost: Number(s.price), varianceReason: String(form.get(`reason:${l.id}`) ?? "").trim(),
        ...(!progress.resolvedIngredientId ? { resolution: s.resolution === "CREATE" ? { type: "CREATE" } : { type: "EXISTING", ingredientId: s.resolution } } : {}) };
    });
    void submit({ kind: "receive", payload: { id: detail.id, key: crypto.randomUUID(), revision: detail.revision, receivedAt: `${form.get("receivedAt")}:00+07:00`, notes: String(form.get("notes") ?? "").trim(), lines } });
  }}><fieldset disabled={locked} className="min-w-0 space-y-5"><legend className="mb-4 text-xl font-semibold">Penerimaan barang</legend>
    <p>Pilih bahan yang datang. Penerimaan sebagian diperbolehkan. Harga naik wajib dijelaskan per bahan, tanpa persetujuan ulang Finance.</p>
    <label className="grid gap-2">Tanggal dan waktu diterima (WIB)<input type="datetime-local" name="receivedAt" className={control} required /></label>
    {detail.lines.filter(l => receipts.lines.find(p => p.lineId === l.id)?.remainingBaseQuantity !== "0").map(l => {
      const progress = receipts.lines.find(p => p.lineId === l.id)!;
      const s = selection[l.id] ?? { selected: false, unit: l.purchaseUnit, price: "", resolution: "" };
      const change = (patch: Partial<typeof s>) => setSelection(old => ({ ...old, [l.id]: { ...s, ...patch } }));
      const increased = priceIncreased(s.price, s.unit, l);
      return <section key={l.id} className="min-w-0 space-y-3 rounded-lg border border-[#dce1d7] p-3">
        <label className="flex min-h-12 items-center gap-3"><input type="checkbox" className="h-6 w-6" checked={s.selected} onChange={e => change({ selected: e.target.checked })} />{l.itemNameSnapshot} — sisa {progress.remainingBaseQuantity} {l.baseUnit}</label>
        {s.selected && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-2">Jumlah diterima<input className={control} name={`quantity:${l.id}`} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,3})?" required /></label>
          <label className="grid min-w-0 gap-2">Satuan penerimaan<select className={control} value={s.unit} onChange={e => change({ unit: e.target.value })}>{units(l.baseUnit).map(u => <option key={u}>{u}</option>)}</select></label>
          <label className="grid min-w-0 gap-2">Harga aktual per {s.unit} (Rp)<input className={control} inputMode="numeric" pattern="[0-9]+" required value={s.price} onChange={e => change({ price: e.target.value })} /></label>
          <label className="grid min-w-0 gap-2">Penjelasan selisih {increased ? "(wajib: harga naik)" : "(opsional)"}<input className={control} name={`reason:${l.id}`} required={increased} maxLength={2000} /></label>
          {!progress.resolvedIngredientId && <label className="grid min-w-0 gap-2 sm:col-span-2">Penyelesaian bahan usulan<select className={control} required value={s.resolution} onChange={e => change({ resolution: e.target.value })}><option value="">Pilih secara eksplisit</option><option value="CREATE">Buat bahan baru: {l.proposedName}</option>{masters.ingredients.filter(m => m.active && m.baseUnit === l.baseUnit).map(m => <option value={m.id} key={m.id}>Gunakan: {m.name}</option>)}</select></label>}
        </div>}
      </section>;
    })}
    <label className="grid gap-2">Catatan penerimaan<input className={control} name="notes" maxLength={1000} /></label>
    <button className={control} disabled={!Object.values(selection).some(s => s.selected)}>Simpan penerimaan dan perbarui stok</button>
  </fieldset></form>;
}
