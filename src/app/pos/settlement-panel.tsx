"use client";

import { useRef, useState } from "react";
import { getShiftSettlementAction } from "@/lib/shifts/settlement-action";

export type Settlement = Extract<Awaited<ReturnType<typeof getShiftSettlementAction>>, { success: true }>["settlement"];
const control = "min-h-12 rounded-lg border border-[#a8aea0] px-4 py-2 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40";
const rupiah = (value: number) => `Rp${new Intl.NumberFormat("id-ID").format(value)}`;
const dateTime = (value: string) => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));

export function SettlementSummary({ settlement }: { settlement: Settlement }) {
  return <dl className="grid gap-4 sm:grid-cols-2">
    <div><dt>Dibuka</dt><dd className="font-semibold"><time dateTime={settlement.openedAt}>{dateTime(settlement.openedAt)} WIB</time></dd></div>
    <div><dt>Ditutup</dt><dd className="font-semibold">{settlement.closedAt ? <time dateTime={settlement.closedAt}>{dateTime(settlement.closedAt)} WIB</time> : "Belum ditutup"}</dd></div>
    {([
      ["Total pesanan", settlement.totalOrders], ["Pesanan lunas", settlement.paidOrders],
      ["Pesanan dibatalkan", settlement.cancelledOrders], ["Penjualan bruto", rupiah(settlement.grossSales)],
      ["Penjualan tunai", rupiah(settlement.cashSales)], ["Penjualan BCA EDC", rupiah(settlement.edcSales)],
      ["Kas yang diharapkan", rupiah(settlement.expectedCash)],
    ] as const).map(([label, value]) => <div key={label} className="rounded-lg bg-[#f6f4ef] p-4"><dt>{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}
  </dl>;
}

export function SettlementPanel({ shiftId }: { shiftId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const request = useRef(0);
  async function load() {
    if (busy.current) return;
    const current = ++request.current;
    busy.current = true;
    setOpen(true);
    setLoading(true);
    setSettlement(null);
    setError(null);
    try {
      const result = await getShiftSettlementAction(shiftId);
      if (current !== request.current) return;
      if (result.success) setSettlement(result.settlement);
      else setError(result.error);
    } catch {
      if (current === request.current) setError("Settlement belum dapat dimuat. Periksa koneksi lalu coba lagi.");
    } finally {
      if (current === request.current) { busy.current = false; setLoading(false); }
    }
  }
  function close() {
    request.current++;
    busy.current = false;
    setLoading(false);
    setOpen(false);
    setSettlement(null);
    setError(null);
  }
  return <>
    <button type="button" className={control} onClick={() => void load()} disabled={loading} aria-expanded={open}>Lihat settlement</button>
    {open && <section aria-label="Settlement shift" className="fixed inset-4 z-50 overflow-y-auto rounded-xl border border-[#a8aea0] bg-[#fffefa] p-6 shadow-xl sm:inset-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-2xl font-semibold">Settlement shift</h2><button type="button" className={control} onClick={close}>Kembali ke POS</button></div>
        <p className="text-[#62685c]">Ringkasan saat dimuat. Muat ulang untuk melihat transaksi terbaru.</p>
        {loading && <p role="status">Memuat settlement…</p>}
        {error && <p role="alert">{error}</p>}
        {settlement && <SettlementSummary settlement={settlement} />}
        <button type="button" className={control} disabled={loading} onClick={() => void load()}>{error ? "Coba lagi" : "Muat ulang"}</button>
      </div>
    </section>}
  </>;
}
