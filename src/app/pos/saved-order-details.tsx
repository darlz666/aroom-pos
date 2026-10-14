"use client";

import { useRef, useState } from "react";
import { defaultCup, type CupCustomization } from "@/lib/orders/customizations";
import { CupCustomizationEditor } from "./cup-customizations";

export function SavedOrderDetails({ item, customerName, disabled, onSave, onClose, onReload }: {
  item?: { id: string; productName: string; quantity: number; cups?: CupCustomization[]; notes?: string };
  customerName?: string; disabled: boolean;
  onSave: (values: { customerName?: string; cups?: CupCustomization[]; notes?: string }) => Promise<boolean>;
  onClose: () => void;
  onReload?: () => void;
}) {
  const [name, setName] = useState(customerName ?? "");
  const [cups, setCups] = useState<CupCustomization[] | undefined>(() => item?.cups ? item.cups.map(cup => ({ ...cup })) : undefined);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const busy = useRef(false);
  async function save() {
    if (busy.current || disabled) return;
    busy.current = true;
    try {
      const success = await onSave(item ? { ...(cups ? { cups } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }
        : { ...(name.trim() ? { customerName: name.trim() } : {}) });
      if (success) onClose();
    } finally { busy.current = false; }
  }
  const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold disabled:opacity-40";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label="Detail pesanan tersimpan" className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl bg-[#fffefa] p-5">
      <h3 className="text-xl font-semibold">{item ? item.productName : "Nama pelanggan"}</h3>
      {item ? <>
        <label className="my-3 flex min-h-12 items-center gap-3"><input className="h-6 w-6" type="checkbox" checked={Boolean(cups)} disabled={disabled} onChange={event => setCups(event.target.checked ? Array.from({ length: item.quantity }, defaultCup) : undefined)} />Label gelas untuk minuman</label>
        {cups && <CupCustomizationEditor cups={cups} onChange={setCups} disabled={disabled} idPrefix={`saved-${item.id}`} />}
        <label className="mt-3 block">Catatan item<input aria-label="Catatan item tersimpan" value={notes} disabled={disabled} maxLength={1000} onChange={event => setNotes(event.target.value)} className={`${control} mt-1 w-full`} /></label>
      </> : <label className="mt-3 block">Nama pelanggan (opsional)<input aria-label="Nama pelanggan tersimpan" value={name} disabled={disabled} maxLength={256} onChange={event => setName(event.target.value)} className={`${control} mt-1 w-full`} /></label>}
      <p className="mt-3 text-sm">Simpan perubahan sebelum melanjutkan pembayaran.</p>
      <div className="mt-4 flex gap-3"><button type="button" className={`${control} bg-[#344631] text-white`} disabled={disabled} onClick={() => void save()}>Simpan detail</button><button type="button" className={control} disabled={disabled} onClick={onClose}>Kembali</button></div>
      {onReload && <button type="button" className={`${control} mt-3`} onClick={onReload}>Muat ulang hasil perubahan</button>}
    </section>
  </div>;
}
