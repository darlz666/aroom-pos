"use client";

import type { getReceiptAction } from "@/lib/orders/actions";

export type Receipt = Extract<Awaited<ReturnType<typeof getReceiptAction>>, { success: true }>["receipt"];
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function ReceiptPanel({ receipt, onClose }: { receipt: Receipt; onClose: () => void }) {
  const { payment } = receipt;
  return <section aria-label="Pratinjau struk" className="col-span-full overflow-y-auto rounded-xl border border-[#a8aea0] bg-[#fffefa] p-6">
    <div className="mx-auto max-w-md space-y-4 break-words">
      <h2 className="text-center text-2xl font-semibold">AROOM Coffee Bar</h2>
      <div>
        <p>Nomor pesanan: {receipt.orderNumber}</p>
        <p>Kasir: {receipt.cashier}</p>
        <p>{receipt.orderType === "DINE_IN" ? "Dine-in" : "Takeaway"}</p>
        <p>Waktu pesanan: <time dateTime={receipt.createdAt}>{dateTime(receipt.createdAt)} WIB</time></p>
      </div>
      <ul aria-label="Item pesanan" className="space-y-3 border-y border-dashed border-[#a8aea0] py-4">
        {receipt.items.map((item, index) => <li key={index}>
          <p className="font-semibold">{item.name}</p>
          <div className="flex justify-between gap-4"><span>{item.quantity} × {rupiah(item.unitPrice)}</span><span>{rupiah(item.lineTotal)}</span></div>
        </li>)}
      </ul>
      <p className="flex justify-between gap-4 text-xl font-semibold"><span>Total</span><span>{rupiah(receipt.total)}</span></p>
      <div className="space-y-1">
        <p>Pembayaran: {payment.method === "CASH" ? "Tunai" : payment.method === "BCA_EDC" ? "BCA EDC" : "QRIS"} · Lunas</p>
        <p>Jumlah pembayaran: {rupiah(payment.amount)}</p>
        {payment.method === "CASH" && <>
          {payment.cashReceived !== null && <p>Uang diterima: {rupiah(payment.cashReceived)}</p>}
          {payment.changeAmount !== null && <p>Kembalian: {rupiah(payment.changeAmount)}</p>}
        </>}
        {payment.method === "BCA_EDC" && payment.edcReference && <p>Referensi EDC: {payment.edcReference}</p>}
      </div>
      <button type="button" onClick={onClose} className="min-h-12 w-full rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade]">Tutup struk</button>
    </div>
  </section>;
}
