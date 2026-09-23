"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getRecipeAction, listRecipeOptionsAction, saveRecipeAction } from "@/lib/inventory/recipe-actions";
import { formatWac, recipeRecoveryKey, restoreRecipeSubmission, type RecipeSubmission } from "@/lib/inventory/recipe-form";
import { card, control, primary, quantity, rupiah } from "../inventory/presentation";

type Options = Awaited<ReturnType<typeof listRecipeOptionsAction>>;
type Detail = Extract<Awaited<ReturnType<typeof getRecipeAction>>, { success: true }>["recipe"];
const errors: Record<string, string> = {
  STALE_RECIPE: "Resep telah berubah. Muat ulang resep sebelum mengedit kembali.",
  IDEMPOTENCY_CONFLICT: "Kunci penyimpanan berbeda dari permintaan tersimpan. Periksa resep terbaru.",
  INGREDIENT_INACTIVE: "Bahan nonaktif hanya dapat dipertahankan tanpa perubahan atau diganti dengan bahan aktif.",
  INVALID_QUANTITY: "Jumlah harus positif, maksimal 3 angka desimal, dan dalam batas yang didukung.",
  INVALID_COST: "HPP melebihi batas biaya yang didukung. Periksa jumlah resep.",
  DUPLICATE_INGREDIENT: "Setiap bahan hanya boleh muncul satu kali.",
  FORBIDDEN: "Akses Anda telah berubah. Masuk kembali dengan akun yang berwenang.",
};
const readError = "Data belum dapat dimuat. Periksa koneksi dan akses, lalu muat ulang.";

function recipeUnits(baseUnit: string) {
  if (baseUnit === "L") return ["ml", "L"];
  if (baseUnit === "kg") return ["g", "kg"];
  if (baseUnit === "g") return ["g"];
  if (baseUnit === "ml") return ["ml"];
  if (baseUnit === "pcs") return ["pcs"];
  return [];
}

export function RecipeWorkspace({ actorId, canEdit, initial }: { actorId: string; canEdit: boolean; initial: Options }) {
  const [options, setOptions] = useState(initial);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [items, setItems] = useState<RecipeSubmission["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<RecipeSubmission | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const intent = useRef<RecipeSubmission | null>(null);
  const busy = useRef(false);
  const reads = useRef(0);
  const mounted = useRef(true);
  const key = recipeRecoveryKey(actorId);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    async function restore() {
      // Browser storage is available only after hydration; keep controls locked
      // until this external recovery state has been read.
      await Promise.resolve();
      if (cancelled) return;
      try {
        const stored = sessionStorage.getItem(key);
        if (stored) {
          const request = restoreRecipeSubmission(stored);
          intent.current = request; setPending(request); setSelected(request.productId); setItems(request.items);
          setMessage("Status penyimpanan belum pasti. Periksa dengan permintaan yang sama.");
        }
      } catch { setBlocked(true); setMessage("Data pemulihan tidak dapat dibaca. Jangan mengirim resep pengganti dari tab ini."); }
      setReady(true);
    }
    void restore();
    const leaving = (event: BeforeUnloadEvent) => { if (intent.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leaving);
    return () => { cancelled = true; mounted.current = false; window.removeEventListener("beforeunload", leaving); };
  }, [key]);

  async function read(productId: string, refreshOptions = false) {
    const sequence = ++reads.current;
    setLoading(true); setDetail(null); setItems([]); setMessage("");
    try {
      const [result, choices] = await Promise.all([
        productId ? getRecipeAction(productId) : Promise.resolve(null),
        refreshOptions ? listRecipeOptionsAction() : Promise.resolve(null),
      ]);
      if (!mounted.current || sequence !== reads.current) return;
      if (choices) setOptions(choices);
      if (result?.success) {
        setDetail(result.recipe);
        setItems(result.recipe.items.map(item => ({ ingredientId: item.ingredientId, quantity: item.quantity, unit: item.unit })));
        setMustReload(false);
      } else if (result) setMessage(errors[result.code] ?? readError);
      if (choices && !choices.success) setMessage(readError);
      return !!result?.success && (!choices || choices.success);
    } catch { if (mounted.current && sequence === reads.current) setMessage(readError); }
    finally { if (mounted.current && sequence === reads.current) setLoading(false); }
  }

  async function send(request: RecipeSubmission, recovering: boolean) {
    if (busy.current || !canEdit || !mounted.current) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Sambungkan kembali sebelum menyimpan."); return; }
    busy.current = true; setSaving(true); ++reads.current;
    try {
      // Persist intent before sending. Never silently submit recovery after reload.
      sessionStorage.setItem(key, JSON.stringify(request));
    } catch {
      busy.current = false; setSaving(false); setMessage("Penyimpanan pemulihan tidak tersedia. Resep belum dikirim."); return;
    }
    intent.current = request; setPending(request);
    try {
      const result = await saveRecipeAction(request);
      if (!mounted.current) return;
      if (result.success) {
        sessionStorage.removeItem(key); intent.current = null; setPending(null);
        const refreshed = await read(request.productId, true);
        if (mounted.current) setMessage(refreshed
          ? "Resep tersimpan. HPP menggunakan WAC saat ini; muat ulang untuk memperbarui estimasi."
          : "Resep tersimpan, tetapi data terbaru belum dapat dimuat. Muat ulang resep & WAC.");
      } else if (result.code === "UNAVAILABLE" || (recovering && result.code !== "STALE_RECIPE")) {
        setMessage("Status penyimpanan belum pasti. Periksa dengan permintaan yang sama.");
      } else {
        sessionStorage.removeItem(key); intent.current = null; setPending(null);
        setMessage(errors[result.code] ?? "Permintaan ditolak. Periksa bahan, satuan, dan jumlah.");
        if (["STALE_RECIPE", "IDEMPOTENCY_CONFLICT", "FORBIDDEN"].includes(result.code)) setMustReload(true);
      }
    } catch { if (mounted.current) setMessage("Status penyimpanan belum pasti. Periksa dengan permintaan yang sama."); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || busy.current || intent.current || !detail || !ready || blocked || loading || mustReload) return;
    let request: RecipeSubmission;
    try { request = restoreRecipeSubmission(JSON.stringify({ productId: detail.productId, expectedRevision: detail.revision, idempotencyKey: crypto.randomUUID(), items })); }
    catch { setMessage("Periksa bahan dan jumlah positif dengan maksimal 3 angka desimal."); return; }
    await send(request, false);
  }
  const locked = saving || !!pending || blocked || !ready;
  const editingDisabled = locked || loading || mustReload || !options.success;
  const update = (index: number, patch: Partial<RecipeSubmission["items"][number]>) => {
    if (editingDisabled || !canEdit) return;
    setItems(current => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  };
  return <div className="space-y-5">
    {!canEdit && <p className={card}>Akses baca saja untuk resep, HPP, dan biaya bahan.</p>}
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-2">Cari produk<input className={control} value={search} onChange={e => setSearch(e.target.value)} /></label>
      <label className="flex min-w-64 flex-1 flex-col gap-2">Produk POS<select className={control} value={selected} disabled={locked || !options.success}
        onChange={e => { if (locked) return; setSelected(e.target.value); void read(e.target.value); }}>
        <option value="">Pilih produk</option>
        {options.success && options.products.filter(product => product.id === selected || product.name.toLowerCase().includes(search.toLowerCase())).map(product =>
          <option key={product.id} value={product.id}>{product.name}{!product.active ? " · Nonaktif" : !product.available ? " · Tidak tersedia" : ""}{product.recipe ? " · Ada resep" : " · Belum ada resep"}</option>)}
      </select></label>
      <button className={control} disabled={locked} onClick={() => void read(selected, true)}>Muat ulang resep &amp; WAC</button>
    </div>
    {!options.success && <p role="alert">{readError}</p>}
    {message && <p role="status" className={card}>{message}</p>}
    {pending && <section className={card}><h2 className="text-xl font-semibold">Penyimpanan perlu diperiksa</h2>
      <p>Isian terkunci sampai server memastikan hasil. Permintaan tersimpan tetap memakai produk dan jumlah semula.</p>
      {canEdit && <button className={`${primary} mt-3`} disabled={saving} onClick={() => intent.current && void send(intent.current, true)}>Periksa / coba lagi</button>}
    </section>}
    {loading && <p role="status">Memuat resep dan WAC…</p>}
    {detail && !loading && <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
      <section className={card}><h2 className="mb-4 text-2xl font-semibold">{detail.productName}</h2>
        {!detail.productActive && <p>Produk nonaktif</p>}{!detail.productAvailable && <p>Produk tidak tersedia di POS</p>}
        {!detail.recipeId && <p className="mb-4">Belum ada resep.</p>}
        {canEdit ? <form onSubmit={submit}>
          <fieldset disabled={editingDisabled} className="space-y-4">
            {items.map((item, index) => <div key={index} className="flex flex-wrap items-end gap-3 rounded-lg border border-[#dedfd5] p-3">
              <label className="flex min-w-48 flex-1 flex-col gap-2">Bahan {index + 1}<select required className={control} value={item.ingredientId} onChange={e => {
                const ingredient = options.success ? options.ingredients.find(row => row.id === e.target.value) : undefined;
                update(index, {
                ingredientId: e.target.value,
                unit: recipeUnits(ingredient?.baseUnit ?? "")[0] ?? ""
              });
              }}><option value="">Pilih bahan</option>
                {options.success && options.ingredients.filter(ingredient => ingredient.id === item.ingredientId || (ingredient.active && !items.some(row => row.ingredientId === ingredient.id))).map(ingredient =>
                  <option key={ingredient.id} value={ingredient.id}>{ingredient.name}{!ingredient.active ? " · Nonaktif — ganti bahan" : ""}</option>)}
              </select></label>
              <label className="flex w-36 flex-col gap-2">Jumlah {index + 1}<input required inputMode="decimal" className={control} value={item.quantity} onChange={e => update(index, { quantity: e.target.value })} /></label>
              <label className="flex w-32 flex-col gap-2">
              Satuan
              <select
                className={control}
                value={item.unit}
                onChange={e => update(index, { unit: e.target.value })}
                required
              >
                <option value="">Pilih</option>

                {(() => {
                  const ingredient = options.success
                    ? options.ingredients.find(row => row.id === item.ingredientId)
                    : undefined;

                  return recipeUnits(ingredient?.baseUnit ?? "").map(unit => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ));
                })()}
              </select>
            </label>
              <button type="button" className={control} onClick={() => { if (!editingDisabled) setItems(current => current.filter((_, i) => i !== index)); }}>Hapus bahan {index + 1}</button>
            </div>)}
            <div className="flex flex-wrap gap-3"><button type="button" className={control} disabled={items.length >= 100} onClick={() => { if (!editingDisabled) setItems(current => [...current, { ingredientId: "", quantity: "", unit: "" }]); }}>Tambah bahan</button>
              <button type="submit" className={primary} disabled={!items.length}>Simpan resep</button></div>
          </fieldset>
        </form> : <ul className="space-y-3">{detail.items.map(item => <li key={item.ingredientId}>{item.ingredientName}{!item.active ? " · Nonaktif" : ""}: {quantity(item.quantity)} {item.unit}</li>)}</ul>}
      </section>
      <section className={card}><h2 className="text-xl font-semibold">HPP resep tersimpan</h2>
        <p className="mb-5 text-sm text-[#62685c]">Estimasi otomatis dari jumlah resep tersimpan × WAC saat dibaca. Simpan perubahan untuk menghitung ulang.</p>
        <p className="mb-5 text-3xl font-semibold">{detail.available ? rupiah(detail.total!) : "HPP belum tersedia"}</p>
        {detail.costError && <p role="alert">HPP melebihi batas biaya yang didukung. Periksa jumlah resep.</p>}
        <ul className="space-y-4">{detail.items.map(item => <li key={item.ingredientId} className="border-t border-[#dedfd5] pt-3">
          <p className="font-semibold">{item.ingredientName}{!item.active ? " · Nonaktif" : ""}</p>
          <p>{quantity(item.quantity)} {item.unit} × {formatWac(item.weightedAverageUnitCostMicros)} / {item.unit}</p>
          <p>{item.hpp === null ? item.weightedAverageUnitCostMicros === null ? "WAC belum diketahui — HPP tidak tersedia" : "HPP melebihi batas biaya" : rupiah(item.hpp)}</p>
        </li>)}</ul>
      </section>
    </div>}
  </div>;
}
