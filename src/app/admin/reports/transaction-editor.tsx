"use client";
import { useEffect, useRef, useState } from "react";
import { adjustTransactionAction, voidTransactionsAction } from "@/lib/reports/adjustment-action";
import type { ReportTransaction } from "@/lib/reports/service";
import { jakartaBusinessDate } from "@/lib/reports/domain";

const control = "min-h-12 rounded-lg border border-[#a8aea0] px-3 py-2 disabled:opacity-40";
type Props = { transactions: ReportTransaction[]; businessDate: string; mode: "edit" | "void"; onClose: () => void; onSaved: () => void };
export function TransactionEditor({ transactions, businessDate, mode, onClose, onSaved }: Props) {
  const original = transactions[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const intent = useRef<unknown>(null);
  const [date, setDate] = useState(jakartaBusinessDate(new Date(original.paidAt)));
  const [number, setNumber] = useState(original.orderNumber);
  const [items, setItems] = useState(original.items.map(item => ({ ...item, quantity: String(item.quantity),
    unitSellingPrice: String(item.unitSellingPrice), unitHpp: item.unitHpp === null ? "" : String(item.unitHpp) })));
  const [fee, setFee] = useState(String(original.channelFee));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const locked = pending || uncertain;
  async function save() {
    if (busy.current) return;
    if (!navigator.onLine) { setError("Tidak ada koneksi. Sambungkan kembali sebelum menyimpan."); return; }
    busy.current = true;
    setPending(true); setError(null);
    const recovering = uncertain;
    try {
      if (!intent.current) intent.current = mode === "edit" ? {
        orderId: original.orderId, expectedRevision: original.revision, idempotencyKey: crypto.randomUUID(),
        businessDate: date, orderNumber: number, channelFee: Number(fee), reason,
        items: items.map(item => ({ productName: item.productName, quantity: Number(item.quantity),
          unitSellingPrice: Number(item.unitSellingPrice), unitHpp: item.unitHpp.trim() === "" ? null : Number(item.unitHpp) })),
      } : { businessDate, reason, transactions: transactions.map(row => ({ orderId: row.orderId, expectedRevision: row.revision })) };
      const result = await (mode === "edit" ? adjustTransactionAction(intent.current) : voidTransactionsAction(intent.current));
      if (result.success) { onSaved(); return; }
      setError(result.error);
      if (result.code === "UNAVAILABLE" || recovering) setUncertain(true);
      else intent.current = null;
    } catch { setUncertain(true); setError("Hasil belum dapat dipastikan. Periksa kembali permintaan yang sama."); }
    finally { busy.current = false; setPending(false); }
  }
  const update = (index: number, field: keyof typeof items[number], value: string) =>
    setItems(current => current.map((item, i) => i === index ? { ...item, [field]: value } : item));
  return <dialog ref={dialog} onClose={onClose} onCancel={event => { if (locked) event.preventDefault(); }}
    aria-labelledby="transaction-editor-title" className="fixed inset-0 m-auto max-h-[90dvh] w-[min(58rem,95vw)] overflow-y-auto rounded-xl border bg-[#fffefa] p-6 shadow-xl backdrop:bg-black/40">
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2 id="transaction-editor-title" className="text-2xl font-semibold">{mode === "edit" ? "Edit Grup Pesanan" : "Hapus transaksi?"}</h2>
      {mode === "void" ? <><p>Transaksi akan dihapus dari laporan aktif, tetapi histori asli tetap disimpan untuk audit.</p>
        <p>{transactions.length} transaksi dipilih</p><ul>{transactions.map(row => <li key={row.orderId}>{row.orderNumber}</li>)}</ul></> : <>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2">Tanggal<input className={control} type="date" required disabled={locked} value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="grid gap-2">No. Pesanan<input className={control} required maxLength={100} disabled={locked} value={number} onChange={e => setNumber(e.target.value)} /></label>
        </div>
        <p className="text-sm">Jam pembayaran asli (WIB) dipertahankan. Perubahan hanya untuk laporan; struk asli, pembayaran, stok dan rekonsiliasi kas tetap tersimpan.</p>
        <h3 className="font-semibold">Daftar Produk</h3>
        {items.map((item, index) => <fieldset key={index} disabled={locked} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-5">
          <label className="grid gap-2">Nama Produk<input aria-label={`Nama Produk ${index + 1}`} className={`${control} w-full`} required maxLength={200} value={item.productName} onChange={e => update(index, "productName", e.target.value)} /></label>
          {([['quantity', 'Qty', 1], ['unitSellingPrice', 'Harga Jual', 0], ['unitHpp', 'HPP', 0]] as const).map(([field, label, min]) =>
            <label key={field} className="grid gap-2">{label}<input aria-label={`${label} ${index + 1}`} className={`${control} w-full`} type="number" inputMode="numeric" min={min} max={2147483647} step="1" required={field !== "unitHpp"} value={item[field]} onChange={e => update(index, field, e.target.value)} /></label>)}
          <button type="button" className={control} disabled={items.length === 1} aria-label={`Hapus produk ${index + 1}`} onClick={() => setItems(current => current.filter((_, i) => i !== index))}>Hapus</button>
        </fieldset>)}
        <button type="button" className={control} disabled={locked || items.length >= 100} onClick={() => setItems(current => [...current, { productName: "", quantity: "1", unitSellingPrice: "0", unitHpp: "" }])}>+ Tambah Produk</button>
        <label className="grid gap-2">Potongan Channel Rp<input className={control} type="number" inputMode="numeric" min="0" max={2147483647} step="1" required disabled={locked} value={fee} onChange={e => setFee(e.target.value)} /></label>
        <p className="text-sm">HPP per unit boleh kosong jika tidak diketahui.</p>
      </>}
      <label className="grid gap-2">Alasan / catatan (opsional)<input className={control} maxLength={500} disabled={locked} value={reason} onChange={e => setReason(e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      {uncertain && <p>Isian dikunci agar percobaan ulang tidak membuat perubahan ganda.</p>}
      <div className="flex gap-3">
        <button type="button" className={control} disabled={locked} onClick={onClose}>Batal</button>
        {uncertain && <button type="button" className={control} disabled={pending} onClick={onSaved}>Muat ulang laporan</button>}
        <button type="submit" className={`${control} bg-[#344631] text-white`} disabled={pending}>{pending ? "Menyimpan…" : uncertain ? "Periksa kembali permintaan" : mode === "edit" ? "Simpan Perubahan" : transactions.length > 1 ? "Hapus Terpilih" : "Hapus Transaksi"}</button>
      </div>
    </form>
  </dialog>;
}
