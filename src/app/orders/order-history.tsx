"use client";

import { useEffect, useRef, useState } from "react";
import { getHistoricalOrderAction, getReceiptAction, listOrderHistoryAction } from "@/lib/orders/actions";
import type { OrderHistoryCursor } from "@/lib/orders/history";
import { ReceiptPanel, type Receipt } from "../pos/receipt-panel";

type HistoryResult = Awaited<ReturnType<typeof listOrderHistoryAction>>;
type History = Extract<HistoryResult, { success: true }>;
type Detail = Extract<Awaited<ReturnType<typeof getHistoricalOrderAction>>, { success: true }>["order"];
type Read<T> = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; data: T };
type Query = { orderNumber?: string; cursor?: OrderHistoryCursor };
const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));
const statusLabel = { UNPAID: "Belum dibayar", PAID: "Lunas", CANCELLED: "Dibatalkan" };
const paymentLabel = { PENDING: "Menunggu kepastian", SUCCEEDED: "Berhasil", FAILED: "Gagal", EXPIRED: "Kedaluwarsa", CANCELLED: "Dibatalkan" };
const methodLabel = { CASH: "Tunai", BCA_EDC: "BCA EDC", MIDTRANS_QRIS: "QRIS" };
function Timestamp({ label, value }: { label: string; value: string | null }) {
  return <p>{label}: {value ? <time dateTime={value}>{dateTime(value)} WIB</time> : "—"}</p>;
}

export function OrderHistory({ initial }: { initial: HistoryResult }) {
  const [list, setList] = useState<Read<History>>(() => initial.success
    ? { status: "ready", data: initial } : { status: "failed", error: "Riwayat belum dapat dimuat. Periksa koneksi atau akses Anda, lalu coba lagi." });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<Query>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Read<Detail> | null>(null);
  const [receipt, setReceipt] = useState<Read<Receipt> | null>(null);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const receiptRequest = useRef(0);
  const receiptBusy = useRef(false);

  // Invalidate pending reads on unmount. Each channel also rejects superseded
  // successes AND failures, so a slow response cannot replace newer content.
  useEffect(() => () => {
    listRequest.current++;
    detailRequest.current++;
    receiptRequest.current++;
  }, []);

  function closeReceipt() {
    receiptRequest.current++;
    receiptBusy.current = false;
    setReceipt(null);
  }
  function closeDetail() {
    detailRequest.current++;
    setSelected(null);
    setDetail(null);
    closeReceipt();
  }
  async function loadList(next: Query) {
    const request = ++listRequest.current;
    closeDetail();
    setQuery(next);
    setList({ status: "loading" });
    try {
      const result = await listOrderHistoryAction(next);
      if (request !== listRequest.current) return;
      setList(result.success ? { status: "ready", data: result } : { status: "failed", error: result.code === "INVALID_INPUT"
        ? "Masukkan nomor pesanan lengkap, misalnya AR-000123."
        : "Riwayat belum dapat dimuat. Periksa koneksi atau akses Anda, lalu coba lagi." });
    } catch {
      if (request === listRequest.current) setList({ status: "failed", error: "Riwayat belum dapat dimuat. Periksa koneksi lalu coba lagi." });
    }
  }
  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    closeReceipt();
    setSelected(id);
    setDetail({ status: "loading" });
    try {
      const result = await getHistoricalOrderAction(id);
      if (request !== detailRequest.current) return;
      setDetail(result.success ? { status: "ready", data: result.order } : { status: "failed", error: "Detail belum dapat dimuat. Periksa koneksi atau akses Anda, lalu coba lagi." });
    } catch {
      if (request === detailRequest.current) setDetail({ status: "failed", error: "Detail belum dapat dimuat. Periksa koneksi lalu coba lagi." });
    }
  }
  async function loadReceipt() {
    if (receiptBusy.current || detail?.status !== "ready" || detail.data.status !== "PAID") return;
    receiptBusy.current = true;
    const request = ++receiptRequest.current;
    setReceipt({ status: "loading" });
    try {
      // Always reauthorize and fetch the paid-only projection. Never build a
      // receipt from list/detail state or submit any financial mutation.
      const result = await getReceiptAction(detail.data.id);
      if (request !== receiptRequest.current) return;
      if (result.success) setReceipt({ status: "ready", data: result.receipt });
      else {
        receiptBusy.current = false;
        setReceipt({ status: "failed", error: "Struk belum dapat dimuat. Periksa koneksi atau akses Anda, lalu coba lagi." });
      }
    } catch {
      if (request === receiptRequest.current) {
        receiptBusy.current = false;
        setReceipt({ status: "failed", error: "Struk belum dapat dimuat. Periksa koneksi lalu coba lagi." });
      }
    }
  }

  return <div className="grid min-h-0 min-w-0 flex-1 gap-6 p-4 sm:p-6 lg:grid-cols-2 lg:overflow-hidden">
    <section aria-label="Daftar riwayat pesanan" className="min-w-0 space-y-4 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-4 lg:overflow-y-auto">
      <p className="text-[#62685c]">Pesanan terbaru lebih dahulu. Riwayat tetap tersedia setelah shift ditutup.</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault();
        const orderNumber = search.trim().toUpperCase();
        void loadList(orderNumber ? { orderNumber } : {});
      }}>
        <label className="flex min-w-0 flex-1 flex-col gap-2">Nomor pesanan lengkap
          <input value={search} onChange={event => setSearch(event.target.value)} maxLength={64} placeholder="AR-000123" autoCapitalize="characters"
            className="min-h-12 min-w-0 rounded-lg border border-[#a8aea0] px-3" />
        </label>
        <button type="submit" className={control}>Cari</button>
        <button type="button" className={control} onClick={() => { setSearch(""); void loadList({}); }}>Semua pesanan</button>
      </form>
      {query.orderNumber && <p>Pencarian tepat: <strong>{query.orderNumber}</strong></p>}
      {list.status === "loading" && <p role="status">Memuat riwayat pesanan...</p>}
      {list.status === "failed" && <p role="alert">{list.error}</p>}
      <button type="button" className={control} disabled={list.status === "loading"} onClick={() => void loadList(query)}>
        {list.status === "failed" ? "Coba lagi riwayat" : "Muat ulang halaman"}
      </button>
      {list.status === "ready" && <>
        {list.data.orders.length === 0 ? <p>{query.orderNumber ? "Nomor pesanan tidak ditemukan." : "Belum ada riwayat pesanan."}</p> :
          <ul className="space-y-3">{list.data.orders.map(order => <li key={order.id}>
            <button type="button" className={`${control} w-full space-y-1 text-left`} aria-pressed={selected === order.id}
              aria-label={`Lihat ${order.orderNumber}`} onClick={() => void loadDetail(order.id)}>
              <span className="flex flex-wrap justify-between gap-2"><strong>{order.orderNumber}</strong><span>{statusLabel[order.status]}</span></span>
              <span className="block"><time dateTime={order.createdAt}>{dateTime(order.createdAt)} WIB</time> · {order.orderType === "DINE_IN" ? "Dine-in" : "Takeaway"}</span>
              <span className="block">Kasir: {order.cashier.name} · Pemilik shift: {order.shift.cashier.name}</span>
              <span className="block text-xl">{rupiah(order.total)}</span>
            </button>
          </li>)}</ul>}
        <div className="flex flex-wrap gap-3">
          {query.cursor && <button type="button" className={control} onClick={() => void loadList(query.orderNumber ? { orderNumber: query.orderNumber } : {})}>Halaman pertama</button>}
          {list.data.nextCursor && <button type="button" className={control} onClick={() => void loadList({ ...query, cursor: list.data.nextCursor! })}>Halaman berikutnya</button>}
        </div>
      </>}
    </section>
    <section aria-label="Detail riwayat pesanan" className="min-w-0 space-y-4 rounded-xl border border-[#dedfd5] bg-[#fffefa] p-4 lg:overflow-y-auto">
      <h2 className="text-2xl font-semibold">Detail pesanan</h2>
      {!selected && <p>Pilih pesanan untuk melihat detail tersimpan.</p>}
      {selected && <button type="button" className={control} onClick={closeDetail}>Tutup detail</button>}
      {detail?.status === "loading" && <p role="status">Memuat detail pesanan...</p>}
      {detail?.status === "failed" && <><p role="alert">{detail.error}</p><button type="button" className={control} onClick={() => void loadDetail(selected!)}>Coba lagi detail</button></>}
      {detail?.status === "ready" && <>
        <HistoricalDetail order={detail.data} />
        {detail.data.status === "PAID" && receipt?.status !== "ready" && <button type="button" className={control}
          disabled={receipt?.status === "loading"} onClick={() => void loadReceipt()}>{receipt?.status === "failed" ? "Coba lagi struk" : "Cetak ulang struk"}</button>}
        {receipt?.status === "loading" && <p role="status">Memuat struk tersimpan...</p>}
        {receipt?.status === "failed" && <p role="alert">{receipt.error}</p>}
        {receipt?.status === "ready" && <ReceiptPanel key={detail.data.id} receipt={receipt.data} copy onClose={closeReceipt} />}
      </>}
    </section>
  </div>;
}

function HistoricalDetail({ order }: { order: Detail }) {
  return <div className="space-y-4 break-words">
    <h3 className="text-xl font-semibold">{order.orderNumber} · {statusLabel[order.status]}</h3>
    <p>{order.orderType === "DINE_IN" ? "Dine-in" : "Takeaway"} · Kasir: {order.cashier.name}</p>
    <p>Pemilik shift: {order.shift.cashier.name} · {order.shift.status === "CLOSED" ? "Shift ditutup" : "Shift terbuka"}</p>
    <div><Timestamp label="Dibuat" value={order.createdAt} /><Timestamp label="Dibayar" value={order.paidAt} /><Timestamp label="Dibatalkan" value={order.cancelledAt} /></div>
    <ul aria-label="Item tersimpan" className="space-y-3 border-y border-dashed border-[#a8aea0] py-4">
      {order.items.map(item => <li key={item.id}><p className="font-semibold">{item.productName}</p>
        <p>{item.quantity} × {rupiah(item.unitPrice)} · {rupiah(item.lineTotal)}</p>{item.notes && <p>Catatan: {item.notes}</p>}
      </li>)}
    </ul>
    <p className="text-2xl font-semibold">Total: {rupiah(order.total)}</p>
    <h4 className="font-semibold">Riwayat pembayaran</h4>
    {order.payments.length === 0 && <p>Belum ada pembayaran.</p>}
    <ul className="space-y-4">{order.payments.map(payment => <li key={payment.id} className="rounded-lg bg-[#f6f4ef] p-3">
      <p>{methodLabel[payment.method]} · {paymentLabel[payment.status]} · {rupiah(payment.amount)}</p>
      <Timestamp label="Dibuat" value={payment.createdAt} /><Timestamp label="Diperbarui" value={payment.updatedAt} /><Timestamp label="Berhasil" value={payment.succeededAt} />
      {payment.method === "CASH" && <>
        {payment.cashReceived !== null && <p>Uang diterima: {rupiah(payment.cashReceived)}</p>}
        {payment.changeAmount !== null && <p>Kembalian: {rupiah(payment.changeAmount)}</p>}
      </>}
      {payment.method === "BCA_EDC" && payment.edcReference && <p>Referensi EDC: {payment.edcReference}</p>}
    </li>)}</ul>
  </div>;
}
