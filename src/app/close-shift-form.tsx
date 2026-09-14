"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { closeShiftAction } from "@/lib/shifts/close-action";

const control = "min-h-14 w-full rounded-lg border border-[#a8aea0] bg-white px-4 py-3 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:opacity-60";
const button = "min-h-14 w-full rounded-lg px-5 py-3 text-lg font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e503c] disabled:opacity-60";

export function CloseShiftForm({ shiftId, requiresAdminReason }: { shiftId: string; requiresAdminReason: boolean }) {
  const router = useRouter();
  const submitting = useRef(false);
  const cashRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [cash, setCash] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const busy = pending || refreshing || confirmed;

  useEffect(() => {
    if (review) headingRef.current?.focus();
    else if (error?.code === "INVALID_MONEY") cashRef.current?.focus();
    else if (error?.code === "REASON_REQUIRED") reasonRef.current?.focus();
    else if (error?.code === "DISCREPANCY_NOTE_REQUIRED") noteRef.current?.focus();
    else if (!confirmed) cashRef.current?.focus();
  }, [review, error, confirmed]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    if (!/^[0-9]+$/.test(cash) || !Number.isSafeInteger(Number(cash))) {
      setReview(false);
      setError({ code: "INVALID_MONEY", message: "Masukkan kas fisik dalam angka rupiah utuh, tanpa tanda atau pemisah. Nilai 0 diperbolehkan." });
      return;
    }
    if (requiresAdminReason && !reason.trim()) {
      setReview(false);
      setError({ code: "REASON_REQUIRED", message: "Isi alasan admin menutup shift milik pengguna lain." });
      return;
    }
    if (!review) { setError(null); setReview(true); return; }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await closeShiftAction({ shiftId, countedCash: cash, discrepancyNote: note, adminCloseReason: reason });
      if (result.success) {
        setConfirmed(true);
        startTransition(() => router.refresh());
      } else {
        setReview(false);
        setError({ code: result.code, message: result.error });
        if (result.code === "SHIFT_NOT_OPEN") startTransition(() => router.refresh());
      }
    } catch {
      setReview(false);
      setError({ code: "UNAVAILABLE", message: "Status penutupan belum dapat dipastikan. Periksa koneksi dan muat ulang status register sebelum mencoba lagi." });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-busy={busy} className="mt-8 border-t border-[#dedfd5] pt-6">
      <fieldset disabled={busy} className="space-y-5">
        <legend className="text-2xl font-semibold">Tutup shift</legend>
        {requiresAdminReason && <p className="mt-4 text-[#62685c]">Anda menutup shift milik pengguna lain. Kepemilikan shift tidak berubah.</p>}
        <div hidden={review || confirmed} className="space-y-5">
          <div>
            <label htmlFor="counted-cash" className="block text-lg font-semibold">Kas fisik saat tutup</label>
            <p id="counted-help" className="mt-2 text-[#62685c]">Hitung uang tunai di laci. Isi angka tanpa titik atau koma; 0 diperbolehkan.</p>
            <div className="relative mt-3">
              <span aria-hidden="true" className="absolute top-1/2 left-4 -translate-y-1/2 text-xl">Rp</span>
              <input ref={cashRef} id="counted-cash" type="text" inputMode="numeric" pattern="[0-9]+" required autoComplete="off" value={cash} onChange={e => setCash(e.target.value)} aria-invalid={error?.code === "INVALID_MONEY" || undefined} aria-describedby={`counted-help${error?.code === "INVALID_MONEY" ? " close-error" : ""}`} className={`${control} min-h-16 pl-14 text-3xl tabular-nums`} />
            </div>
          </div>
          <div>
            <label htmlFor="discrepancy-note" className="block text-lg font-semibold">Catatan selisih</label>
            <p id="note-help" className="mt-2 text-[#62685c]">Opsional. Wajib diisi jika server menemukan kas fisik berbeda dari kas yang diharapkan.</p>
            <textarea ref={noteRef} id="discrepancy-note" rows={2} value={note} onChange={e => setNote(e.target.value)} aria-invalid={error?.code === "DISCREPANCY_NOTE_REQUIRED" || undefined} aria-describedby={`note-help${error?.code === "DISCREPANCY_NOTE_REQUIRED" ? " close-error" : ""}`} className={`${control} mt-3`} />
          </div>
          {requiresAdminReason && <div>
            <label htmlFor="admin-close-reason" className="block text-lg font-semibold">Alasan admin menutup shift</label>
            <textarea ref={reasonRef} id="admin-close-reason" required rows={2} value={reason} onChange={e => setReason(e.target.value)} aria-invalid={error?.code === "REASON_REQUIRED" || undefined} aria-describedby={error?.code === "REASON_REQUIRED" ? "close-error" : undefined} className={`${control} mt-3`} />
          </div>}
        </div>
        {review && !confirmed && <div className="space-y-4">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold focus-visible:outline-2">Konfirmasi penutupan shift</h2>
          <p>Kas fisik saat tutup: <strong className="break-all">Rp{cash}</strong></p>
          {note && <p className="whitespace-pre-wrap break-words">Catatan selisih: {note}</p>}
          {requiresAdminReason && <p className="whitespace-pre-wrap break-words">Alasan admin menutup shift: {reason}</p>}
          <p className="leading-relaxed text-[#62685c]">Server akan menghitung kas yang diharapkan dan selisih saat Anda mengonfirmasi. Jika ada selisih tanpa catatan atau transaksi belum selesai, shift tidak akan ditutup.</p>
          <button type="button" onClick={() => setReview(false)} className={`${button} border border-[#a8aea0]`}>Kembali ke isian</button>
        </div>}
        {!confirmed && <button type="submit" className={`${button} bg-[#344631] text-white hover:bg-[#293926]`}>{pending ? "Menutup shift..." : refreshing ? "Memuat status..." : review ? "Konfirmasi dan tutup shift" : "Tinjau penutupan"}</button>}
      </fieldset>
      <div aria-live="polite" aria-atomic="true" className="mt-4">
        {error && <p id="close-error" className="rounded-lg border border-[#e5c8c1] bg-[#fcf1ed] px-4 py-3 text-[#8b3026]">{error.message}</p>}
        {pending && <p>Memeriksa rekonsiliasi di server...</p>}
        {confirmed && <p>Shift berhasil ditutup dan rekonsiliasi tersimpan. Memuat status register...</p>}
      </div>
      {(confirmed || error?.code === "UNAVAILABLE" || error?.code === "SHIFT_NOT_OPEN") && (
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a href="/" className="mt-3 inline-flex min-h-14 items-center rounded px-3 text-[#3e503c] underline focus-visible:outline-2">Muat ulang status register</a>
      )}
    </form>
  );
}
