"use client";
import { useEffect, useRef, useState } from "react";
import { inventoryPurchaseOrderListAction, inventoryPurchaseOrderDetailAction, inventoryPurchaseOrderHistoryAction, inventoryPurchaseOrderReceiptsAction, inventoryPurchaseOrderWriteAction, inventoryPurchaseOrderReceiveAction } from "@/lib/inventory-purchase-orders/actions";
import { listIngredientsAction, listSuppliersAction } from "@/lib/inventory/actions";
import { validateIntent, validateVariance } from "./form-input";
import { DraftForm, ReceiveForm } from "./forms";
import { allowedOperations, card, control, errors, labels, money, operations, time, type Detail, type Intent, type Masters, type Receipts } from "./presentation";

type List = Extract<Awaited<ReturnType<typeof inventoryPurchaseOrderListAction>>, { success: true }>["data"];
type History = Extract<Awaited<ReturnType<typeof inventoryPurchaseOrderHistoryAction>>, { success: true }>["data"];
type Data = { list: List; detail: Detail | null; history: History | null; receipts: Receipts | null; masters: Masters };

export function PurchaseOrderWorkspace({ role, actorId, approvals = false }: { role: string; actorId: string; approvals?: boolean }) {
  const [status, setStatus] = useState(approvals ? "WAITING_APPROVAL" : "");
  const [page, setPage] = useState(1), [historyPage, setHistoryPage] = useState(1), [receiptPage, setReceiptPage] = useState(1);
  const [id, setId] = useState<string | null>(null), [reload, setReload] = useState(0);
  const [data, setData] = useState<Data | null>(null), [readError, setReadError] = useState("");
  const [editing, setEditing] = useState<Detail | "new" | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const flight = useRef(false), generation = useRef(0);
  const storageKey = `inventory-po-pending:${actorId}`;
  /* Recovery must run after mount because sessionStorage is browser-only. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) { const recovered = JSON.parse(saved); validateIntent(recovered); setIntent(recovered); setMessage("Hasil permintaan sebelumnya belum pasti. Ulangi permintaan yang sama."); }
      setReady(true);
    } catch { setMessage("Penyimpanan pemulihan tidak tersedia atau rusak. Periksa riwayat sebelum melanjutkan; pengiriman dikunci."); }
  }, [storageKey]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    async function read() {
      const [list, detail, history, receipts, ingredients, suppliers] = await Promise.all([
        inventoryPurchaseOrderListAction({ page, ...(status ? { status } : {}) }),
        id ? inventoryPurchaseOrderDetailAction({ id }) : null,
        id ? inventoryPurchaseOrderHistoryAction({ id, page: historyPage }) : null,
        id ? inventoryPurchaseOrderReceiptsAction({ id, page: receiptPage }) : null,
        role === "STOCK_MANAGEMENT" ? listIngredientsAction() : null,
        role === "STOCK_MANAGEMENT" ? listSuppliersAction() : null,
      ]);
      if (!active || version !== generation.current) return;
      if (!list.success) throw new Error(list.error);
      if (detail && !detail.success) throw new Error(detail.error);
      if (history && !history.success) throw new Error(history.error);
      if (receipts && !receipts.success) throw new Error(receipts.error);
      if (ingredients && !ingredients.success) throw new Error(ingredients.error);
      if (suppliers && !suppliers.success) throw new Error(suppliers.error);
      if (detail?.success && receipts?.success && detail.data.revision !== receipts.data.revision) throw new Error("PO berubah saat dibaca. Muat ulang data terbaru.");
      setData({ list: list.data, detail: detail?.data ?? null, history: history?.data ?? null, receipts: receipts?.data ?? null,
        masters: { ingredients: ingredients?.ingredients ?? [], suppliers: suppliers?.suppliers ?? [] } });
    }
    void read().catch(error => { if (active && version === generation.current) setReadError(error instanceof Error ? error.message : "PO belum dapat dimuat."); });
    return () => { active = false; };
  }, [page, status, id, reload, historyPage, receiptPage, role]);
  function refresh() { generation.current++; setData(null); setReadError(""); setReload(n => n + 1); }
  function select(next: string | null) { setId(next); setEditing(null); setHistoryPage(1); setReceiptPage(1); refresh(); }
  async function submit(request: Intent) {
    if (!ready || flight.current || (intent && JSON.stringify(intent) !== JSON.stringify(request))) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Permintaan belum dikirim; tidak ada antrean otomatis."); return; }
    const replay = intent !== null;
    try {
      validateIntent(request);
      if (!replay && data?.detail) validateVariance(request, data.detail);
      sessionStorage.setItem(storageKey, JSON.stringify(request));
    } catch (error) { const code = (error as { code?: string }).code; setMessage(code && errors[code] || "Periksa isian, jumlah, harga, satuan, dan penyimpanan pemulihan. Harga harus rupiah utuh; total tidak boleh pecahan rupiah."); return; }
    flight.current = true; setBusy(true); setIntent(request); setMessage("");
    try {
      const response = await (request.kind === "receive" ? inventoryPurchaseOrderReceiveAction(request.payload) : inventoryPurchaseOrderWriteAction(request.payload));
      if (!response.success) {
        setMessage(errors[response.code] ?? response.error);
        // A later rejection does not prove an earlier interrupted write failed.
        if (!response.retryable && !replay) {
          sessionStorage.removeItem(storageKey); setIntent(null);
          // These rejected transactions changed nothing. Keep the mounted form
          // so the user can correct its inputs without retyping every line.
          // State, permissions and master availability errors require a refresh.
          if (!["INVALID_INPUT", "DUPLICATE_INGREDIENT", "VARIANCE_REASON_REQUIRED"].includes(response.code)) {
            setEditing(null); refresh();
          }
        }
        return;
      }
      sessionStorage.removeItem(storageKey); setIntent(null); select(response.data.id);
      setMessage(request.kind === "receive" ? "Penerimaan tersimpan. Stok, progres PO, dan riwayat dimuat ulang dari server." : "PO tersimpan. Data terbaru dimuat dari server.");
    } catch { setMessage("Hasil belum pasti. Jangan buat permintaan baru; ulangi permintaan yang sama."); }
    finally { flight.current = false; setBusy(false); }
  }
  const detail = data?.detail, locked = !ready || busy || !!intent || !data;
  return <section className="min-w-0 space-y-5 text-[#292e28]">
    <p>Pembelian bahan dan persediaan. Stok diperbarui hanya setelah penerimaan berhasil.</p>
    {role === "ADMIN" && <p className={card}>Pengawasan ADMIN — hanya baca.</p>}
    <nav aria-label="Ringkasan PO" className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {[["", "Semua PO"], ["WAITING_APPROVAL", "Menunggu persetujuan"], ["APPROVED", "Siap dipesan"], ["PARTIALLY_RECEIVED", "Diterima sebagian"]].map(([value, label]) => <button key={value} className={control} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(1); select(null); }}>{label}</button>)}
    </nav>
    <div className="flex flex-wrap gap-3">{id && <button className={control} onClick={() => select(null)}>Kembali ke daftar</button>}<button className={control} onClick={() => { setEditing(null); refresh(); }}>Muat ulang</button>{role === "STOCK_MANAGEMENT" && <button className={control} disabled={locked} onClick={() => setEditing("new")}>PO baru</button>}</div>
    {message && <p role="status" className={card}>{message}</p>}
    {intent && <aside className={card}><p>Permintaan belum terselesaikan. Isian dikunci. Pemulihan menggunakan data dan kunci yang sama.</p><p className="break-all">PO: {intent.payload.id}</p><button className={control} disabled={busy || !ready} onClick={() => void submit(intent)}>Ulangi permintaan yang sama</button><button className={control} onClick={() => select(intent.payload.id)}>Periksa PO tersimpan</button></aside>}
    {!data && !readError && <p role="status">Memuat PO…</p>}
    {readError && <div role="alert" className={card}><p>{readError}</p><button className={control} onClick={refresh}>Coba lagi</button></div>}
    {data && <>
      {editing && <DraftForm key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`} detail={editing === "new" ? null : editing} locked={locked} masters={data.masters} submit={submit} cancel={() => setEditing(null)} />}
      {!detail && !editing && <section className="min-w-0 space-y-4"><h2 className="text-xl font-semibold">Daftar permintaan PO</h2>
        <label className="grid gap-2">Status<select className={control} value={status} onChange={e => { setStatus(e.target.value); setPage(1); select(null); }}><option value="">Semua status</option>{Object.entries(labels).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        {!data.list.rows.length && <p className={card}>Belum ada PO untuk filter ini.</p>}
        <div className="grid min-w-0 gap-3 md:grid-cols-2">{data.list.rows.map(row => <article className={card} key={row.id}><h3 className="font-semibold">{row.supplierNameSnapshot}</h3><p className="break-all text-sm">{row.referenceNumber}</p><p>{labels[row.status]} · {row.lines.length} bahan</p><p>Estimasi: {money(row.estimatedTotal)}</p><button className={control} onClick={() => select(row.id)}>Detail PO</button></article>)}</div>
        <Pager page={page} more={data.list.hasMore} change={n => { setPage(n); refresh(); }} />
      </section>}
      {detail && !editing && <article className={card}><h2 className="text-xl font-semibold">Detail PO</h2><p className="break-all">{detail.referenceNumber}</p><p>{detail.supplierNameSnapshot} · {labels[detail.status]} · Revisi {detail.revision}</p><p>Dibuat: {time(detail.createdAt)} · {detail.createdBy}</p><p>{detail.notes}</p><p>Estimasi PO: {money(detail.estimatedTotal)}</p><p>Aktual barang diterima: {money(data.receipts?.actualReceivedTotal ?? null)}</p>
        {detail.decisionNote && <p>Catatan Finance: {detail.decisionNote}</p>}
        <div className="grid min-w-0 gap-3 md:grid-cols-2">{detail.lines.map(l => { const p = data.receipts?.lines.find(p => p.lineId === l.id); return <section className={card} key={l.id}><h3 className="font-semibold">{l.itemNameSnapshot}{l.proposedName ? " (usulan)" : ""}</h3><p>{l.purchaseQuantity} {l.purchaseUnit} × {money(l.estimatedUnitPrice)}/{l.purchaseUnit}</p><p>Estimasi: {money(l.estimatedTotal)}</p><p>Jumlah dasar: {l.baseQuantity} {l.baseUnit}</p>{p && <><p>Diterima: {p.receivedBaseQuantity} {p.baseUnit} · Sisa: {p.remainingBaseQuantity} {p.baseUnit}</p><p>Aktual diterima: {money(p.actualReceivedTotal)}</p></>}</section>; })}</div>
        {role === "STOCK_MANAGEMENT" && detail.status === "DRAFT" && <button className={control} disabled={locked} onClick={() => setEditing(detail)}>Ubah draf</button>}
        <DecisionForm key={`${detail.id}:${detail.revision}`} role={role} actorId={actorId} detail={detail} locked={locked} submit={submit} />
        {role === "STOCK_MANAGEMENT" && ["ORDERED", "PARTIALLY_RECEIVED"].includes(detail.status) && data.receipts && <ReceiveForm key={`${detail.id}:${detail.revision}`} detail={detail} receipts={data.receipts} masters={data.masters} locked={locked} submit={submit} />}
        {role === "STOCK_MANAGEMENT" && data.receipts && <section className="space-y-2"><h3 className="font-semibold">Stok saat ini (server)</h3>{data.receipts.lines.map(p => { const m = data.masters.ingredients.find(m => m.id === p.resolvedIngredientId); return m ? <p key={p.lineId}>{m.name}: {m.currentStock} {m.baseUnit}</p> : null; })}</section>}
        {data.receipts && <section className="min-w-0 space-y-4"><h3 className="text-lg font-semibold">Riwayat penerimaan dan selisih harga</h3>{!data.receipts.receipts.length && <p>Belum ada penerimaan. Biaya aktual belum diketahui.</p>}{data.receipts.receipts.map(receipt => <section className={card} key={receipt.id}><p className="break-all font-semibold">{receipt.referenceNumber}</p><p>Supplier: {receipt.supplierName}</p><p>Diterima: {time(receipt.receivedAt)}</p><p>Dicatat: {time(receipt.postedAt)} · {receipt.actorId}</p><p>{receipt.notes}</p>{receipt.items.map(item => <div className="space-y-2 border-t border-[#dce1d7] pt-3" key={item.id}><p className="font-semibold">{item.ingredientName}: {item.quantity} {item.unit}</p><p>Harga disetujui: {money(item.approvedUnitPrice)}/{item.approvedPurchaseUnit}</p><p>Harga aktual: {money(item.purchaseUnitCost)}/{item.unit}</p><p>Estimasi setara jumlah diterima: {money(item.approvedEstimatedAmountMicros, true)}</p><p>Aktual: {money(item.actualAmount)} · Selisih: {money(item.priceVarianceMicros, true)}</p><p>Penjelasan: {item.varianceReason ?? "—"}</p></div>)}</section>)}<Pager page={receiptPage} more={data.receipts.hasMore} change={n => { setReceiptPage(n); refresh(); }} /></section>}
        {data.history && <section className="min-w-0 space-y-4"><h3 className="text-lg font-semibold">Riwayat audit · WIB</h3>{data.history.rows.map(event => <div className="space-y-2 border-l-2 border-[#a8aea0] pl-3" key={event.revision}><p>{operations[event.operation] ?? event.operation} · Revisi {event.revision}</p><p>{event.fromStatus ? labels[event.fromStatus] : "Baru"} → {labels[event.toStatus]}</p><p>{time(event.createdAt)} · {event.actorId}</p><p>{event.note}</p></div>)}<Pager page={historyPage} more={data.history.hasMore} change={n => { setHistoryPage(n); refresh(); }} /></section>}
      </article>}
    </>}
  </section>;
}

export function DecisionForm({ role, actorId, detail, locked, submit }: { role: string; actorId: string; detail: Detail; locked: boolean; submit: (intent: Intent) => Promise<void> }) {
  const options = allowedOperations(role, actorId, detail);
  const [operation, setOperation] = useState(options[0] ?? "");
  if (!options.length) return null;
  return <form onSubmit={e => { e.preventDefault(); if (locked) return; const form = new FormData(e.currentTarget); void submit({ kind: "write", payload: { id: detail.id, key: crypto.randomUUID(), revision: detail.revision, operation, note: String(form.get("note") ?? "").trim() } }); }}><fieldset disabled={locked} className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-3 font-semibold">Perubahan status</legend><label className="grid gap-2">Aksi<select className={control} value={operation} onChange={e => setOperation(e.target.value)}>{options.map(op => <option key={op} value={op}>{operations[op]}</option>)}</select></label><label className="grid gap-2">Catatan {operation === "REJECT" ? "(wajib)" : "(opsional)"}<input name="note" className={control} required={operation === "REJECT"} maxLength={2000} /></label><button className={control}>Konfirmasi: {operations[operation]}</button></fieldset></form>;
}
function Pager({ page, more, change }: { page: number; more: boolean; change: (page: number) => void }) {
  return <div className="flex flex-wrap items-center gap-3"><button className={control} disabled={page === 1} onClick={() => change(page - 1)}>Sebelumnya</button><span>Halaman {page}</span><button className={control} disabled={!more} onClick={() => change(page + 1)}>Berikutnya</button></div>;
}
