"use client";

import type { CupCustomization } from "@/lib/orders/customizations";

const field = "min-h-12 w-full rounded-lg border border-[#a8aea0] bg-white px-3 disabled:opacity-50";
export function CupCustomizationEditor({ cups, onChange, disabled, idPrefix }: {
  cups: readonly CupCustomization[]; onChange: (cups: CupCustomization[]) => void; disabled: boolean; idPrefix: string;
}) {
  function update(index: number, values: Partial<CupCustomization>) {
    if (!disabled) onChange(cups.map((cup, position) => position === index ? { ...cup, ...values } : cup));
  }
  return <div className="mt-3 space-y-2" aria-label="Kustomisasi tiap gelas">
    {cups.map((cup, index) => <details key={index} className="rounded-lg border border-[#dedfd5] p-3" open={cups.length === 1}>
      <summary className="min-h-12 cursor-pointer py-3 font-semibold">Gelas {index + 1} · {cup.sugar.replaceAll("_", " ")} · {cup.ice.replaceAll("_", " ")} · {cup.cup}{cup.notes ? " · Catatan" : ""}</summary>
      <div className="grid gap-3 sm:grid-cols-3">
        <label htmlFor={`${idPrefix}-sugar-${index}`}>Sugar<select id={`${idPrefix}-sugar-${index}`} aria-label={`Sugar gelas ${index + 1}`} className={field} value={cup.sugar} disabled={disabled} onChange={event => update(index, { sugar: event.target.value as CupCustomization["sugar"] })}>
          <option value="NORMAL">NORMAL</option><option value="LESS">LESS</option><option value="NO_SUGAR">NO SUGAR</option>
        </select></label>
        <label htmlFor={`${idPrefix}-ice-${index}`}>Ice<select id={`${idPrefix}-ice-${index}`} aria-label={`Ice gelas ${index + 1}`} className={field} value={cup.ice} disabled={disabled} onChange={event => update(index, { ice: event.target.value as CupCustomization["ice"] })}>
          <option value="NORMAL">NORMAL</option><option value="LESS">LESS</option><option value="NO_ICE">NO ICE</option>
        </select></label>
        <label htmlFor={`${idPrefix}-cup-${index}`}>Cup<select id={`${idPrefix}-cup-${index}`} aria-label={`Cup gelas ${index + 1}`} className={field} value={cup.cup} disabled={disabled} onChange={event => update(index, { cup: event.target.value as CupCustomization["cup"] })}>
          <option value="REGULAR">REGULAR</option><option value="LARGE">LARGE</option>
        </select></label>
      </div>
      <label htmlFor={`${idPrefix}-notes-${index}`} className="mt-3 block">Catatan gelas {index + 1}<input id={`${idPrefix}-notes-${index}`} aria-label={`Catatan gelas ${index + 1}`} className={field} value={cup.notes} disabled={disabled} maxLength={600} onChange={event => update(index, { notes: event.target.value })} /></label>
    </details>)}
    <p className="text-sm text-[#62685c]">Opsi label tidak menambah harga atau mengubah resep stok.</p>
  </div>;
}
