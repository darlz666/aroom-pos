"use client";

import { useEffect, useRef, useState } from "react";
import { listIngredientsAction, listSuppliersAction } from "@/lib/inventory/actions";
import { SuppliersPanel } from "./suppliers-panel";
import { StockInForm } from "./stock-in-form";
import { StockInHistory } from "./stock-in-history";
import { card, control, quantity, readError, statusLabels, type HistoryResult, type IngredientsResult, type SuppliersResult } from "./presentation";

export function InventoryWorkspace({ actorId, initialIngredients, initialSuppliers, initialHistory }: {
  actorId: string; initialIngredients: IngredientsResult; initialSuppliers: SuppliersResult; initialHistory: HistoryResult;
}) {
  const [tab, setTab] = useState("stock");
  const [ingredients, setIngredients] = useState(initialIngredients);
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [historyVersion, setHistoryVersion] = useState(0);
  const stockRequest = useRef(0), supplierRequest = useRef(0);
  useEffect(() => () => { stockRequest.current++; supplierRequest.current++; }, []);

  async function reload() {
    const stockVersion = ++stockRequest.current, supplierVersion = ++supplierRequest.current;
    setBusy(true);
    const [stock, suppliers] = await Promise.allSettled([listIngredientsAction(), listSuppliersAction()]);
    if (stockVersion !== stockRequest.current) return;
    setIngredients(stock.status === "fulfilled" ? stock.value : { success: false, code: "UNAVAILABLE", error: readError });
    if (supplierVersion === supplierRequest.current) {
      setSuppliers(suppliers.status === "fulfilled" ? suppliers.value : { success: false, code: "UNAVAILABLE", error: readError });
    }
    setBusy(false);
  }
  const rows = ingredients.success ? ingredients.ingredients.filter(row => row.name.toLocaleLowerCase("id-ID").includes(search.toLocaleLowerCase("id-ID")) &&
    (filter === "ALL" || (filter === "INACTIVE" ? !row.active : row.active && row.stockStatus === filter))) : [];

  return <div className="space-y-5">
    <nav aria-label="Inventory" className="flex flex-wrap gap-3">{[["stock", "Stok bahan"], ["suppliers", "Supplier"], ["receive", "Stock In"], ["history", "Riwayat Stock In"]].map(([key, label]) =>
      <button type="button" key={key} aria-current={tab === key ? "page" : undefined} className={`${control} font-semibold ${tab === key ? "border-[#344631] bg-[#e9eade]" : ""}`} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <section hidden={tab !== "stock"} aria-label="Stok bahan" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-2xl font-semibold">Stok bahan saat ini</h2><p className="text-[#62685c]">Saldo bersama untuk seluruh resep, dalam satuan dasar.</p></div>
        <button type="button" className={control} disabled={busy || writing} onClick={reload}>Muat ulang stok</button></div>
      <div className="flex flex-wrap gap-4"><label className="grid flex-1 gap-2">Cari bahan<input value={search} onChange={e => setSearch(e.target.value)} className={control} type="search" /></label>
        <label className="grid gap-2">Status<select className={control} value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">Semua bahan</option><option value="EMPTY">Habis</option><option value="LOW">Stok rendah</option><option value="AVAILABLE">Tersedia</option><option value="INACTIVE">Nonaktif</option></select></label></div>
      {busy ? <p role="status">Memuat stok terbaru…</p> : !ingredients.success ? <p role="alert">{readError}</p> : <>
        {!rows.length && <p>{ingredients.ingredients.length ? "Tidak ada bahan yang cocok." : "Belum ada bahan. Hubungi Admin untuk menyiapkan data bahan."}</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map(row => <article key={row.id} className={card}>
          <h3 className="break-words text-xl font-semibold">{row.name}</h3>
          <p className="my-3 text-3xl font-semibold tabular-nums">{quantity(row.currentStock)} <span className="text-lg">{row.baseUnit}</span></p>
          <p>Minimum: {quantity(row.minimumStock)} {row.baseUnit}</p>
          <p className={`mt-3 inline-block rounded-full px-3 py-1 font-semibold ${row.stockStatus === "AVAILABLE" ? "bg-[#e4edde] text-[#344631]" : "bg-[#fff0dc] text-[#804215]"}`}>{statusLabels[row.stockStatus]}</p>
          {!row.active && <p className="mt-2 font-semibold">Nonaktif</p>}
        </article>)}</div>
      </>}
    </section>
    <section hidden={tab !== "suppliers"} aria-label="Supplier"><SuppliersPanel result={suppliers} loading={busy} reload={reload} onWriting={setWriting} onSaved={supplier => {
      // A saved supplier supersedes supplier reads, never the receiving stock refresh.
      supplierRequest.current++;
      setSuppliers(current => current.success ? { success: true, suppliers: [...current.suppliers.filter(row => row.id !== supplier.id), supplier].sort((a, b) => a.name.localeCompare(b.name)) } : current);
    }} /></section>
    <section hidden={tab !== "receive"} aria-label="Stock In"><StockInForm actorId={actorId} ingredients={ingredients} suppliers={suppliers} loading={busy} reload={reload}
      onSaved={() => { setHistoryVersion(version => version + 1); void reload(); }} onHistory={() => setTab("history")} /></section>
    <section hidden={tab !== "history"} aria-label="Riwayat Stock In"><StockInHistory key={historyVersion} initial={historyVersion === 0 ? initialHistory : undefined} /></section>
  </div>;
}
