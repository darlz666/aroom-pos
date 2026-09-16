"use client";

import { useRef, useState } from "react";
import type { SafeOrder } from "@/lib/orders/actions";
import { submitPaymentAction } from "./payment-action";

type Request = { orderId: string; expectedRevision: number; attemptIdentifier: string } &
  ({ method: "CASH"; cashReceived: number } | { method: "BCA_EDC"; edcReference?: string });
type Payment = Extract<Awaited<ReturnType<typeof submitPaymentAction>>, { success: true }>["payment"];
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold disabled:opacity-40 disabled:cursor-not-allowed";
const messages = {
  INVALID_INPUT: "Data pembayaran tidak valid. Periksa isian.",
  FORBIDDEN: "Anda tidak memiliki izin untuk pembayaran ini.",
  NO_ACTIVE_SHIFT: "Shift tidak aktif. Periksa status shift.",
  ORDER_NOT_FOUND: "Pesanan tidak ditemukan. Muat ulang pesanan.",
  ORDER_NOT_PAYABLE: "Pesanan sudah dibayar atau dibatalkan. Muat ulang pesanan.",
  REVISION_CONFLICT: "Pesanan telah berubah. Kembali, muat ulang pesanan dan tinjau total sebelum membayar.",
  PAYMENT_BLOCKED: "Ada pembayaran yang belum selesai atau sudah berhasil. Periksa status sebelum melanjutkan.",
  IDEMPOTENCY_CONFLICT: "Identitas pembayaran tidak cocok. Hentikan pembayaran dan minta admin memeriksa statusnya.",
  PRODUCT_UNAVAILABLE: "Produk tidak tersedia. Kembali dan periksa pesanan.",
  PRICE_CHANGED: "Harga berubah. Kembali dan periksa pesanan sebelum membayar.",
  INVALID_ORDER_TOTAL: "Total pesanan tidak valid. Minta admin memeriksa pesanan.",
  INSUFFICIENT_CASH: "Uang diterima kurang dari total pesanan.",
  PAYMENT_FAILED: "Status pembayaran belum dapat dipastikan. Periksa koneksi lalu periksa hasil dengan permintaan yang sama. Jangan menerima pembayaran lagi atau meninggalkan halaman ini.",
};

export function PaymentPanel({ order, onClose, onPaid, onReceipt, receiptLoading, receiptError }: {
  order: SafeOrder; onClose: () => void; onPaid: () => void;
  onReceipt: () => void; receiptLoading: boolean; receiptError: string | null;
}) {
  const [method, setMethod] = useState<"CASH" | "BCA_EDC">("CASH");
  const [cash, setCash] = useState("");
  const [reference, setReference] = useState("");
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [stopped, setStopped] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const busy = useRef(false);
  const attempt = useRef<Request | null>(null);
  const uncertain = useRef(false);
  const terminal = useRef(false);
  const received = /^\d+$/.test(cash) ? Number(cash) : NaN;
  const validCash = Number.isInteger(received) && received >= order.total && received <= 2147483647;

  async function submit() {
    if (busy.current || terminal.current || order.status !== "UNPAID") return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("Tidak ada koneksi. Hubungkan perangkat lalu coba lagi; pembayaran tidak dikirim otomatis.");
      return;
    }
    if (!attempt.current) {
      if ((method === "CASH" && !validCash) || (method === "BCA_EDC" && (!approved || [...reference.trim()].length > 100))) return;
      attempt.current = { orderId: order.id, expectedRevision: order.revision, attemptIdentifier: crypto.randomUUID(),
        ...(method === "CASH" ? { method, cashReceived: received } : { method, ...(reference.trim() ? { edcReference: reference.trim() } : {}) }) };
    }
    busy.current = true;
    setPending(true);
    setLocked(true);
    setError(null);
    try {
      const result = await submitPaymentAction(attempt.current);
      if (result.success) {
        terminal.current = true; setStopped(true);
        setPayment(result.payment);
        onPaid();
      } else {
        setError(messages[result.code]);
        if (result.code === "PAYMENT_FAILED") { uncertain.current = true; setRetrying(true); }
        else if (uncertain.current || result.code === "IDEMPOTENCY_CONFLICT") {
          terminal.current = true; setStopped(true);
          setError(`${messages[result.code]} Status percobaan sebelumnya belum terselesaikan. Minta admin memeriksa; jangan menerima pembayaran lagi.`);
        } else {
          attempt.current = null;
          setLocked(false);
          // A rejected order must be reloaded and reviewed before a new attempt.
          if (!["INVALID_INPUT", "INSUFFICIENT_CASH"].includes(result.code)) terminal.current = true; setStopped(true);
        }
      }
    } catch {
      uncertain.current = true; setRetrying(true);
      setError(messages.PAYMENT_FAILED);
    } finally { busy.current = false; setPending(false); }
  }

  return <section aria-label="Pembayaran" className="col-span-full rounded-xl border border-[#a8aea0] bg-[#fffefa] p-6">
    <h2 className="text-2xl font-semibold">Pembayaran {order.orderNumber}</h2>
    {payment ? <div role="status" className="mt-4 space-y-3">
      <p className="text-xl font-semibold">Pembayaran berhasil · SUCCEEDED · Pesanan PAID</p>
      <p>{payment.method === "CASH" ? "Tunai" : "BCA EDC"} · Total {rupiah(payment.amount)}</p>
      {payment.cashReceived !== null && <p>Uang diterima: {rupiah(payment.cashReceived)} · Kembalian: {rupiah(payment.changeAmount ?? 0)}</p>}
      {payment.edcReference && <p>Referensi EDC: {payment.edcReference}</p>}
      {payment.replayed && <p>Pembayaran ditemukan kembali. Jangan menerima pembayaran lagi.</p>}
      <button type="button" className={control} disabled={receiptLoading} onClick={onReceipt}>{receiptLoading ? "Memuat struk..." : "Lihat Struk"}</button>
      {receiptError && <p role="alert" className="text-[#8b3026]">{receiptError}</p>}
      <button type="button" className={control} onClick={onClose}>Selesai</button>
    </div> : <>
      <p className="my-4 text-3xl font-semibold">Total {rupiah(order.total)}</p>
      <p>Total dari server. Tinjau jumlah sebelum menerima pembayaran.</p>
      <fieldset disabled={locked || stopped} className="mt-4 space-y-4">
        <legend className="mb-2 font-semibold">Metode pembayaran</legend>
        <div className="flex gap-3"><button type="button" className={control} aria-pressed={method === "CASH"} onClick={() => { if (!attempt.current) setMethod("CASH"); }}>Tunai</button><button type="button" className={control} aria-pressed={method === "BCA_EDC"} onClick={() => { if (!attempt.current) setMethod("BCA_EDC"); }}>BCA EDC</button><button type="button" className={control} disabled>QRIS (belum tersedia)</button></div>
        {method === "CASH" ? <label className="block">Uang diterima (Rp)<input className={`${control} mt-2 block w-full`} inputMode="numeric" value={cash} onChange={event => { if (!attempt.current) setCash(event.target.value); }} />
          <span className="mt-2 block">{validCash ? `Kembalian: ${rupiah(received - order.total)} (perkiraan)` : "Masukkan rupiah bulat, minimal sebesar total."}</span>
        </label> : <div className="space-y-3"><p>Masukkan {rupiah(order.total)} di terminal BCA EDC. Tunggu hasil APPROVED. Jika hasil belum pasti, periksa terminal sebelum melanjutkan.</p>
          <label className="block">Referensi EDC (opsional)<input className={`${control} mt-2 block w-full`} maxLength={100} value={reference} onChange={event => { if (!attempt.current) setReference(event.target.value); }} /></label>
          <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={approved} onChange={event => { if (!attempt.current) setApproved(event.target.checked); }} />Terminal menunjukkan APPROVED</label></div>}
      </fieldset>
      {error && <p role="alert" className="my-4 text-[#8b3026]">{error}{method === "BCA_EDC" && approved && " Terminal sudah disetujui: jangan proses pembayaran lagi di EDC. Periksa pencatatan POS terlebih dahulu."}</p>}
      {pending && <p role="status">Memeriksa pembayaran. Jangan menerima pembayaran lagi.</p>}
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" className={`${control} bg-[#344631] text-white`} disabled={pending || stopped || (!retrying && (method === "CASH" ? !validCash : !approved))} onClick={() => void submit()}>{pending ? "Memproses..." : retrying ? "Periksa pembayaran yang sama" : method === "CASH" ? "Konfirmasi uang diterima" : "Konfirmasi pembayaran EDC"}</button>
        <button type="button" className={control} disabled={locked} onClick={() => { if (!busy.current && !attempt.current) onClose(); }}>Kembali ke pesanan</button></div>
    </>}
  </section>;
}
