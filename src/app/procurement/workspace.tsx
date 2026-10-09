"use client";
import { useEffect, useRef, useState } from "react";
import { procurementDecisionAction, procurementReadAction, procurementWriteAction } from "@/lib/procurement/actions";
import { categories, mutationInput, priorities, statuses, type Operation } from "@/lib/procurement/domain";

type Result = Awaited<ReturnType<typeof procurementReadAction>>;
type Detail = NonNullable<Extract<Result, { success: true }>["data"]["detail"]>;
type Intent = { id: string; key: string; revision: number; operation: Operation; data?: Record<string, unknown>; note?: string; actualUnitPrice?: number | null };
// Display labels only; persisted values and submitted actions remain unchanged.
const statusLabels: Record<typeof statuses[number], string> = {
  DRAFT: "Draf", WAITING_APPROVAL: "Menunggu Persetujuan", APPROVED: "Disetujui",
  REJECTED: "Ditolak", ORDERED: "Dipesan", RECEIVED: "Diterima", CANCELLED: "Dibatalkan",
};
const categoryLabels: Record<typeof categories[number], string> = {
  FURNITURE: "Furnitur", COFFEE_EQUIPMENT: "Peralatan Kopi", BAR_TOOLS: "Perlengkapan Bar",
  ELECTRONICS: "Elektronik", FIXTURE: "Perlengkapan Tetap", OTHER: "Lainnya",
};
const priorityLabels: Record<typeof priorities[number], string> = {
  NORMAL: "Normal", IMPORTANT: "Penting", URGENT: "Mendesak",
};
const operationLabels: Record<Operation, string> = {
  CREATE: "Buat draf", EDIT: "Ubah draf", SUBMIT: "Ajukan persetujuan", APPROVE: "Setujui pengadaan",
  REJECT: "Tolak pengadaan", ORDER: "Tandai sudah dipesan", RECEIVE: "Tandai sudah diterima", CANCEL: "Batalkan pengadaan",
};
const eventLabels: Record<string, string> = {
  CREATE: "Draf dibuat", EDIT: "Draf diperbarui", SUBMIT: "Persetujuan diajukan", APPROVE: "Pengadaan disetujui",
  REJECT: "Pengadaan ditolak", ORDER: "Barang dipesan", RECEIVE: "Barang diterima", CANCEL: "Pengadaan dibatalkan",
};
const control = "min-h-14 min-w-0 max-w-full rounded-lg border border-[#a8aea0] bg-white px-4 py-3 text-base leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#465443] disabled:opacity-50";
const badge = "inline-flex max-w-full items-center rounded-md border border-[#dce1d7] bg-[#f6f7f3] px-2.5 py-1 text-sm font-medium leading-5";
const money = (n: number | null) => n === null ? "Belum diketahui" : `Rp${new Intl.NumberFormat("id-ID").format(n)}`;
const dateTime = (d: Date | string | null) => d ? new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "—";

function ReferenceNumber({ value }: { value: string }) {
  return <details className="min-w-0 text-sm text-[#62685c]">
    <summary className="min-h-11 cursor-pointer rounded py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#465443]">
      <span className="break-all font-mono" title={value}>{value.length > 24 ? `${value.slice(0, 15)}…${value.slice(-6)}` : value}</span>
      <span className="sr-only"> — Lihat nomor lengkap</span>
    </summary>
    <div className="space-y-2 pb-3">
      <p>Nomor lengkap</p>
      <p className="select-all break-all font-mono text-[#292e28]">{value}</p>
      <p>Tekan lama atau pilih teks untuk menyalin. Gunakan nomor lengkap sebagai acuan.</p>
    </div>
  </details>;
}

export function ProcurementWorkspace({ role, actorId, approvals = false }: { role: string; actorId: string; approvals?: boolean }) {
  const [tab, setTab] = useState(approvals ? "requests" : "dashboard");
  const [status, setStatus] = useState(approvals ? "WAITING_APPROVAL" : ""), [page, setPage] = useState(1), [id, setId] = useState<string>();
  const [result, setResult] = useState<Result | null>(null), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Detail | "new" | null>(null), [intent, setIntent] = useState<Intent | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const flight = useRef(false), generation = useRef(0);
  const storageKey = `procurement-pending:${actorId}`;
  // Recover an exact interrupted request; never auto-submit or silently queue it.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { try { const saved = sessionStorage.getItem(storageKey); if (saved) { const value = JSON.parse(saved); mutationInput(value); setIntent(value); setMessage("Hasil permintaan sebelumnya belum pasti. Ulangi permintaan yang sama."); } setReady(true); } catch { setMessage("Penyimpanan pemulihan tidak tersedia. Periksa riwayat sebelum melanjutkan."); } }, [storageKey]);
  useEffect(() => {
    const version = ++generation.current;
    let active = true;
    procurementReadAction({ page, status, ...(id ? { id } : {}) }).then(r => { if (active && version === generation.current) setResult(r); }).catch(() => { if (active && version === generation.current) setResult({ success: false, error: "Pengadaan belum dapat dimuat.", retryable: true }); });
    return () => { active = false; };
  }, [page, status, id, reload]);
  function refresh() { generation.current++; setResult(null); setReload(n => n + 1); }
  function navigate(next: string) { setTab(next); setEditing(null); setId(undefined); setPage(1); setStatus(next === "requests" && approvals ? "WAITING_APPROVAL" : ""); refresh(); }
  async function submit(request: Intent) {
    if (!ready || flight.current) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Permintaan belum dikirim."); return; }
    try { mutationInput(request); sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Periksa isian dan penyimpanan peramban."); return; }
    flight.current = true; setBusy(true); setIntent(request); setMessage("");
    try {
      const response = await (["APPROVE", "REJECT"].includes(request.operation) ? procurementDecisionAction(request) : procurementWriteAction(request));
      if (!response.success) {
        setMessage(response.error);
        if (!response.retryable) { sessionStorage.removeItem(storageKey); setIntent(null); refresh(); }
        return;
      }
      sessionStorage.removeItem(storageKey); setIntent(null); setEditing(null); setId(response.data.id); setTab("requests"); refresh(); setMessage("Permintaan tersimpan.");
    } catch { setMessage("Hasil belum pasti. Jangan buat permintaan baru; ulangi permintaan yang sama."); }
    finally { flight.current = false; setBusy(false); }
  }
  const detail = result?.success ? result.data.detail : null;
  const locked = !ready || busy || !!intent;
  const row = editing && editing !== "new" ? editing : null;
  return <section className="min-w-0 space-y-6 text-base leading-6">
    <p className="max-w-3xl text-sm leading-6 text-[#62685c]">Pengadaan peralatan dan aset operasional. Bukan pembelian bahan atau persediaan habis pakai.</p>
    <nav aria-label="Pengadaan" className="grid grid-cols-2 gap-2 border-b border-[#dce1d7] pb-5 sm:flex sm:flex-wrap sm:gap-3">
      {[["dashboard", "Ringkasan"], ["requests", approvals ? "Menunggu Persetujuan" : "Permintaan Pengadaan"], ["history", "Riwayat"]].map(([key, label]) => <button className={`${control} font-medium aria-[current=page]:border-[#465443] aria-[current=page]:bg-[#e9ede4]`} aria-current={tab === key ? "page" : undefined} key={key} onClick={() => navigate(key)}>{label}</button>)}
      {role === "PROCUREMENT" && <button className={`${control} font-semibold sm:ml-auto`} aria-current={tab === "new" ? "page" : undefined} disabled={locked} onClick={() => { setTab("new"); setEditing("new"); }}>Permintaan Baru</button>}
    </nav>
    {message && <p role="status" className="rounded-lg border p-4">{message}</p>}
    {intent && <div className="flex flex-wrap items-center gap-3"><p>Isian dikunci sampai hasil dipastikan.</p><button className={control} disabled={busy} onClick={() => void submit(intent)}>Ulangi permintaan yang sama</button><button className={control} disabled={busy} onClick={refresh}>Muat ulang riwayat</button></div>}
    {editing && <form key={row?.id ?? "new"} className="min-w-0 rounded-xl border border-[#dce1d7] bg-white p-4 sm:p-6" onSubmit={e => {
      e.preventDefault(); if (locked) return;
      const values = Object.fromEntries(new FormData(e.currentTarget));
      if (!["quantity", "estimatedUnitPrice"].every(k => /^\d+$/.test(String(values[k])))) { setMessage("Jumlah dan harga harus berupa bilangan bulat tanpa pemisah."); return; }
      void submit({ id: row?.id ?? crypto.randomUUID(), key: crypto.randomUUID(), revision: row?.revision ?? 0, operation: row ? "EDIT" : "CREATE", data: { ...values, quantity: Number(values.quantity), estimatedUnitPrice: Number(values.estimatedUnitPrice) } });
    }}><fieldset disabled={locked} className="grid gap-4 sm:grid-cols-2"><legend className="mb-4 text-2xl font-semibold">{row ? "Ubah Draf" : "Permintaan Baru"}</legend>
      <label className="grid gap-2">Nama barang<input className={control} name="itemName" required maxLength={200} defaultValue={row?.itemName} /></label>
      <label className="grid gap-2">Kategori<select className={control} name="category" defaultValue={row?.category}>{categories.map(v => <option key={v} value={v}>{categoryLabels[v]}</option>)}</select></label>
      <label className="grid gap-2">Jumlah<input className={control} name="quantity" inputMode="numeric" pattern="[0-9]+" required defaultValue={row?.quantity ?? 1} /></label>
      <label className="grid gap-2">Satuan<input className={control} name="unit" required maxLength={30} placeholder="unit, buah, set" defaultValue={row?.unit ?? "unit"} /></label>
      <label className="grid gap-2">Estimasi harga satuan (Rp)<input className={control} name="estimatedUnitPrice" inputMode="numeric" pattern="[0-9]+" required defaultValue={row?.estimatedUnitPrice} /></label>
      <label className="grid gap-2">Pemasok/toko (opsional)<input className={control} name="vendor" maxLength={200} defaultValue={row?.vendor ?? ""} /></label>
      <label className="grid gap-2">Tautan produk (opsional)<input className={control} name="productUrl" type="url" maxLength={2000} defaultValue={row?.productUrl ?? ""} /></label>
      <label className="grid gap-2">Tanggal dibutuhkan (opsional)<input className={control} name="neededDate" type="date" defaultValue={row?.neededDate ? new Date(row.neededDate).toISOString().slice(0, 10) : ""} /></label>
      <label className="grid gap-2">Prioritas<select className={control} name="priority" defaultValue={row?.priority ?? "NORMAL"}>{priorities.map(v => <option key={v} value={v}>{priorityLabels[v]}</option>)}</select></label>
      <label className="grid gap-2">Alasan kebutuhan<textarea className={control} name="reason" required maxLength={2000} defaultValue={row?.reason} /></label>
      <label className="grid gap-2 sm:col-span-2">Catatan (opsional)<textarea className={control} name="notes" maxLength={2000} defaultValue={row?.notes ?? ""} /></label>
      <button className={control}>Simpan Draf</button><button className={control} type="button" onClick={() => { setEditing(null); setTab("requests"); }}>Tutup formulir</button>
    </fieldset></form>}
    {!result && <p role="status" className="rounded-xl border border-[#dce1d7] bg-white p-6 text-[#62685c]">Memuat pengadaan…</p>}
    {result && !result.success && <div role="alert" className="flex flex-col items-start gap-4 rounded-xl border border-[#a8aea0] bg-white p-6"><p>{result.error}</p><button className={control} onClick={refresh}>Coba lagi</button></div>}
    {result?.success && tab === "dashboard" && <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{[
        ["Menunggu Persetujuan", result.data.dashboard.waiting], ["Disetujui", result.data.dashboard.approved], ["Dipesan", result.data.dashboard.ordered],
        ["Diterima Bulan Ini", result.data.dashboard.received], ["Estimasi Nilai Pengadaan Bulan Ini", money(result.data.dashboard.estimated)], ["Nilai Pembelian Aktual Bulan Ini", money(result.data.dashboard.actual)],
      ].map(([label, value]) => <div className="flex min-w-0 flex-col justify-between gap-4 rounded-xl border border-[#dce1d7] bg-white p-5 sm:p-6" key={label}><h2 className="text-sm font-medium leading-6 text-[#62685c]">{label}</h2><p className="text-2xl font-semibold leading-tight tracking-tight break-words tabular-nums [overflow-wrap:anywhere] xl:text-3xl">{value}</p></div>)}</div>
      <p className="rounded-xl border border-[#dce1d7] p-4 text-sm leading-6 text-[#62685c]">Bulan {result.data.dashboard.month} · Asia/Jakarta. Estimasi berdasarkan tanggal dibuat, termasuk draf dan tidak termasuk ditolak/dibatalkan. Aktual berdasarkan tanggal dipesan; harga yang belum diketahui tidak dianggap nol. Diterima berdasarkan tanggal penerimaan. Kartu status menghitung seluruh permintaan saat ini.</p>
    </>}
    {result?.success && ["requests", "history"].includes(tab) && <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="grid min-w-0 gap-2 text-sm font-medium">Status<select className={control} value={status} onChange={e => { setStatus(e.target.value); setPage(1); setId(undefined); refresh(); }}><option value="">Semua status</option>{statuses.map(v => <option key={v} value={v}>{statusLabels[v]}</option>)}</select></label><button className={control} onClick={refresh}>Muat ulang</button></div>
      {result.data.rows.length === 0 && <p className="rounded-xl border border-[#dce1d7] bg-white p-6 text-[#62685c]">Belum ada permintaan untuk filter ini.</p>}
      {result.data.rows.length > 0 && <>
        <div className="grid min-w-0 gap-4 md:grid-cols-2 lg:hidden">{result.data.rows.map(r => <article className="flex min-w-0 flex-col gap-4 rounded-xl border border-[#dce1d7] bg-white p-4" key={r.id}>
          <div className="min-w-0"><h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{r.itemName}</h2><ReferenceNumber value={r.referenceNumber} /></div>
          <dl className="grid grid-cols-2 gap-4">
            <div><dt className="mb-1 text-sm text-[#62685c]">Status</dt><dd><span className={badge}>{statusLabels[r.status]}</span></dd></div>
            <div><dt className="mb-1 text-sm text-[#62685c]">Prioritas</dt><dd><span className={badge}>{priorityLabels[r.priority]}</span></dd></div>
            <div className="min-w-0"><dt className="mb-1 text-sm text-[#62685c]">Total estimasi</dt><dd className="font-semibold tabular-nums [overflow-wrap:anywhere]">{money(r.estimatedTotal)}</dd></div>
            <div className="min-w-0"><dt className="mb-1 text-sm text-[#62685c]">Total pembelian aktual</dt><dd className="font-semibold tabular-nums [overflow-wrap:anywhere]">{money(r.actualTotal)}</dd></div>
          </dl>
          <button className={`${control} mt-auto w-full font-medium`} aria-label={`Detail ${r.itemName}`} onClick={() => { setId(r.id); setEditing(null); refresh(); }}>Detail</button>
        </article>)}</div>
        <div className="hidden rounded-xl border border-[#dce1d7] bg-white lg:block"><table className="w-full table-fixed text-left text-sm leading-6">
          <colgroup><col className="w-[27%]" /><col className="w-[16%]" /><col className="w-[12%]" /><col className="w-[17%]" /><col className="w-[17%]" /><col className="w-[11%]" /></colgroup>
          <thead className="border-b border-[#dce1d7] text-[#62685c]"><tr>{["Nomor / Barang", "Status", "Prioritas", "Total estimasi", "Total pembelian aktual", "Aksi"].map((v, i) => <th scope="col" className={`px-3 py-4 font-medium ${i === 3 || i === 4 ? "text-right" : ""}`} key={v}>{v}</th>)}</tr></thead>
          <tbody className="divide-y divide-[#e5e8e0]">{result.data.rows.map(r => <tr className="align-top" key={r.id}>
            <td className="px-3 py-4"><p className="font-semibold [overflow-wrap:anywhere]">{r.itemName}</p><ReferenceNumber value={r.referenceNumber} /></td>
            <td className="px-3 py-4"><span className={badge}>{statusLabels[r.status]}</span></td><td className="px-3 py-4"><span className={badge}>{priorityLabels[r.priority]}</span></td>
            <td className="px-3 py-4 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{money(r.estimatedTotal)}</td><td className="px-3 py-4 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{money(r.actualTotal)}</td>
            <td className="px-3 py-4"><button className={`${control} !px-3 !text-sm`} aria-label={`Detail ${r.itemName}`} onClick={() => { setId(r.id); setEditing(null); refresh(); }}>Detail</button></td>
          </tr>)}</tbody>
        </table></div>
      </>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#dce1d7] pt-4"><span className="w-full text-center text-sm text-[#62685c] sm:order-2 sm:w-auto">Halaman {page}</span><button className={`${control} sm:order-1`} disabled={page === 1} onClick={() => { setPage(p => p - 1); refresh(); }}>Sebelumnya</button><button className={`${control} sm:order-3`} disabled={!result.data.hasMore} onClick={() => { setPage(p => p + 1); refresh(); }}>Berikutnya</button></div>
    </>}
    {detail && !editing && <article className="min-w-0 space-y-6 rounded-xl border border-[#dce1d7] bg-white p-4 sm:p-6">
      <header className="space-y-3 border-b border-[#dce1d7] pb-5">
        <h2 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{detail.itemName}</h2>
        <span className={badge}>{statusLabels[detail.status]}</span>
        <p className="select-all break-all font-mono text-sm text-[#62685c]">{detail.referenceNumber}</p>
      </header>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        {[
          { title: "Informasi Barang", fields: { Kategori: categoryLabels[detail.category], Jumlah: `${detail.quantity} ${detail.unit}`, "Alasan kebutuhan": detail.reason, Catatan: detail.notes ?? "—" } },
          { title: "Informasi Pengadaan", fields: { Prioritas: priorityLabels[detail.priority], "Estimasi harga satuan": money(detail.estimatedUnitPrice), "Total estimasi": money(detail.estimatedTotal), "Tanggal dibutuhkan": detail.neededDate ? new Date(detail.neededDate).toISOString().slice(0, 10) : "—", "Dibuat oleh": detail.creator.name, "Dibuat pada": dateTime(detail.createdAt), "Diperbarui pada": dateTime(detail.updatedAt), "Dibatalkan pada": dateTime(detail.cancelledAt), "Alasan pembatalan": detail.cancellationReason ?? "—" } },
          { title: "Persetujuan", fields: { "Keputusan oleh": detail.decisionActor?.name ?? "—", "Waktu keputusan": dateTime(detail.decidedAt), "Catatan keputusan": detail.decisionNote ?? "—" } },
          { title: "Pembelian", fields: { "Pemasok/toko": detail.vendor ?? "—", "Harga beli aktual per satuan": money(detail.actualUnitPrice), "Total pembelian aktual": money(detail.actualTotal), "Dipesan pada": dateTime(detail.orderedAt), "Diterima pada": dateTime(detail.receivedAt) } },
        ].map(({ title, fields }) => <section className="min-w-0" key={title}>
          <h3 className="mb-3 text-base font-semibold">{title}</h3>
          <dl className="divide-y divide-[#e5e8e0]">{Object.entries(fields).map(([label, value]) => <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-3 text-sm leading-6" key={label}>
            <dt className="text-[#62685c]">{label}</dt><dd className="min-w-0 whitespace-pre-wrap tabular-nums [overflow-wrap:anywhere]">{value}</dd>
          </div>)}</dl>
          {title === "Informasi Barang" && detail.productUrl && <a className="inline-flex min-h-14 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2" href={detail.productUrl} target="_blank" rel="noopener noreferrer">Lihat produk</a>}
        </section>)}
      </div>
      {role === "PROCUREMENT" && detail.status === "DRAFT" && <button className={control} disabled={locked} onClick={() => setEditing(detail)}>Ubah Draf</button>}
      <TransitionForm key={`${detail.id}:${detail.revision}`} detail={detail} role={role} actorId={actorId} locked={locked} submit={submit} />
      <section className="space-y-4 border-t border-[#dce1d7] pt-5">
        <h3 className="text-lg font-semibold">Riwayat Aktivitas · WIB</h3>
        <ol className="space-y-5">{detail.events.map(event => <li className="space-y-1 border-l-2 border-[#a8aea0] pl-4 [overflow-wrap:anywhere]" key={event.key}>
          <p className="font-medium">{eventLabels[event.operation]}: {event.fromStatus ? statusLabels[event.fromStatus] : "Baru"} → {statusLabels[event.toStatus]}</p>
          <p className="text-sm leading-6 text-[#62685c]">{event.actor.name} · {dateTime(event.createdAt)} · Revisi {event.revision}</p>
          {event.note && <p className="whitespace-pre-wrap text-sm leading-6">{event.note}</p>}
        </li>)}</ol>
      </section>
    </article>}
  </section>;
}

function TransitionForm({ detail, role, actorId, locked, submit }: { detail: Detail; role: string; actorId: string; locked: boolean; submit: (request: Intent) => Promise<void> }) {
  const options: Operation[] = role === "FINANCE" && detail.createdBy !== actorId && detail.status === "WAITING_APPROVAL" ? ["APPROVE", "REJECT"] : role === "PROCUREMENT" ? ({ DRAFT: ["SUBMIT", "CANCEL"], WAITING_APPROVAL: ["CANCEL"], APPROVED: ["ORDER", "CANCEL"], ORDERED: ["RECEIVE"], REJECTED: [], RECEIVED: [], CANCELLED: [] } as Record<string, Operation[]>)[detail.status] : [];
  const [operation, setOperation] = useState<Operation>(options[0] ?? "SUBMIT");
  if (!options.length) return null;
  return <form className="min-w-0 space-y-4 rounded-lg border border-[#dce1d7] bg-[#f6f4ef] p-4 sm:p-5" onSubmit={e => {
    e.preventDefault(); if (locked) return;
    const data = new FormData(e.currentTarget), price = String(data.get("actualUnitPrice") ?? "");
    if (operation === "ORDER" && price && !/^\d+$/.test(price)) return;
    if (!window.confirm(`${operationLabels[operation]} untuk permintaan ${detail.itemName}?`)) return;
    void submit({ id: detail.id, key: crypto.randomUUID(), revision: detail.revision, operation, note: String(data.get("note")), ...(operation === "ORDER" ? { actualUnitPrice: price ? Number(price) : null } : {}) });
  }}><fieldset disabled={locked} className="grid min-w-0 gap-4 sm:grid-cols-2"><legend className="mb-4 font-semibold">Perubahan status</legend>
    <label className="grid min-w-0 content-start gap-2 text-sm font-medium">Aksi<select className={`${control} w-full`} value={operation} onChange={e => setOperation(e.target.value as Operation)}>{options.map(o => <option key={o} value={o}>{operationLabels[o]}</option>)}</select></label>
    <label className="grid min-w-0 gap-2 text-sm font-medium">Catatan {operation === "REJECT" || operation === "CANCEL" ? "(wajib)" : "(opsional)"}<textarea className={`${control} min-h-28 w-full`} name="note" maxLength={2000} required={operation === "REJECT" || operation === "CANCEL"} /></label>
    {operation === "ORDER" && <label className="grid min-w-0 gap-2 text-sm font-medium">Harga beli aktual per satuan (Rp, opsional; kosongkan jika belum diketahui)<input className={`${control} w-full`} name="actualUnitPrice" inputMode="numeric" pattern="[0-9]*" /></label>}
    <button className={`${control} w-full self-end font-semibold sm:col-span-2 sm:w-auto sm:justify-self-start`}>Konfirmasi: {operationLabels[operation]}</button>
  </fieldset></form>;
}
