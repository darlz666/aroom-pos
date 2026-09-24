"use client";

import { useEffect, useRef, useState } from "react";
import { getStockInAction, listStockInsAction } from "@/lib/inventory/actions";
import { card, control, dateTime, quantity, readError, rupiah, type HistoryResult, type StockInDetail } from "./presentation";

export function StockInHistory({ initial }: { initial?: HistoryResult }) {
  const [list, setList] = useState(initial);
  const [loading, setLoading] = useState(!initial);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<StockInDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const listRequest = useRef(0), detailRequest = useRef(0);

  async function load(next?: string) {
    const request = ++listRequest.current;
    detailRequest.current++; setSelected(null); setDetail(null); setDetailError("");
    setLoading(true); setCursor(next);
    try { const result = await listStockInsAction(next ? { cursor: next } : {}); if (request === listRequest.current) setList(result); }
    catch { if (request === listRequest.current) setList({ success: false, code: "UNAVAILABLE", error: readError }); }
    finally { if (request === listRequest.current) setLoading(false); }
  }
  useEffect(() => {
    const lists = listRequest, details = detailRequest;
    if (!initial) {
      const request = ++lists.current;
      void listStockInsAction().then(result => {
        if (request === lists.current) setList(result);
      }).catch(() => {
        if (request === lists.current) setList({ success: false, code: "UNAVAILABLE", error: readError });
      }).finally(() => { if (request === lists.current) setLoading(false); });
    }
    return () => { lists.current++; details.current++; };
  }, [initial]);

  async function open(id: string) {
    const request = ++detailRequest.current;
    setModalOpen(false);

    setTimeout(() => {
      setSelected(id);
      setDetail(null);
      setDetailError("");

      requestAnimationFrame(() => {
        setModalOpen(true);
      });
}, 20);
    try {
      const result = await getStockInAction(id);
      if (request !== detailRequest.current) return;
      if (result.success) setDetail(result.stockIn); else setDetailError(readError);
    } catch { if (request === detailRequest.current) setDetailError(readError); }
  }
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-2xl font-semibold">Riwayat Stock In</h2><button type="button" className={control} onClick={() => load()}>Muat ulang riwayat</button></div>
    <p>Urutan pencatatan terbaru. Waktu penerimaan ditampilkan dalam WIB.</p>
    {loading ? <p role="status">Memuat riwayat…</p> : !list?.success ? <div><p role="alert">{readError}</p><button className={control} type="button" onClick={() => load(cursor)}>Coba muat riwayat lagi</button></div> : <>
      {!list.entries.length && <p>Belum ada penerimaan stok.</p>}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="space-y-3">{list.entries.map(row => <button type="button" key={row.id} onClick={() => open(row.id)} aria-pressed={selected === row.id}
          className={`${card} min-h-14 w-full text-left focus-visible:outline-2 ${selected === row.id ? "ring-2 ring-[#344631]" : ""}`}>
          <span className="block text-xl font-semibold">{row.supplierName}</span><span className="block break-all text-sm">{row.referenceNumber}</span>
          <span className="block">{dateTime(row.receivedAt)} WIB</span><span className="block">{row.itemCount} bahan · {rupiah(row.total)}</span><span className="block">Dicatat oleh {row.actorName}</span><span className="mt-2 block font-semibold">Lihat detail</span>
        </button>)}</div>
          {selected && (
          <div
            className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 transition-opacity duration-300 ${
              modalOpen ? "opacity-100" : "opacity-0"
            }`}
          >
          <section
            className={`${card} max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl shadow-2xl transition-all duration-300 ease-out ${
            modalOpen
              ? "scale-100 translate-y-0 opacity-100"
              : "scale-95 translate-y-4 opacity-0"
          }`}
            aria-label="Detail Stock In"
          >
          <div className="flex items-center justify-between gap-3"><h3 className="text-xl font-semibold">Detail penerimaan</h3><button
            type="button"
            className={control}
            onClick={() => {
              detailRequest.current++;
              setModalOpen(false);

              setTimeout(() => {
                setSelected(null);
                setDetail(null);
              }, 300);
            }}
          >
            Tutup detail
          </button></div>
          {detailError ? <div><p role="alert">{detailError}</p><button type="button" className={control} onClick={() => open(selected)}>Coba muat detail lagi</button></div> : !detail ? <p role="status">Memuat detail…</p> : <div className="mt-4 space-y-4">
            <div><p className="text-xl font-semibold">{detail.supplierName}</p><p className="break-all text-sm">{detail.referenceNumber}</p>
              <p>Diterima: {dateTime(detail.receivedAt)} WIB</p><p>Dicatat: {dateTime(detail.createdAt)} WIB</p><p>Oleh: {detail.actorName}</p><p className="whitespace-pre-wrap break-words">{detail.notes}</p></div>
            {detail.items.map(item => <article key={item.id} className="border-t border-[#dedfd5] pt-4"><h4 className="break-words text-lg font-semibold">{item.ingredientName}</h4>
              <p>{quantity(item.inputQuantity)} {item.inputUnit} → {quantity(item.baseQuantity)} {item.baseUnit}</p>
              <p>{rupiah(item.purchaseUnitCost ?? item.unitCost!)} / {item.purchaseUnitCost !== null ? item.inputUnit : item.baseUnit}</p><p className="text-lg font-semibold">{rupiah(item.lineTotal)}</p></article>)}
            <p className="border-t border-[#dedfd5] pt-4 text-2xl font-semibold">Total {rupiah(detail.total)}</p>
          </div>}
            </section>
  </div>
)}
      </div>
      <div className="flex gap-3">{cursor && <button type="button" className={control} onClick={() => load()}>Kembali ke terbaru</button>}{list.nextCursor && <button type="button" className={control} onClick={() => load(list.nextCursor!)}>Lebih lama</button>}</div>
    </>}
  </div>;
}
