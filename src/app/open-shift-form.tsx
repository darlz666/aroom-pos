"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { openShiftAction } from "@/lib/shifts/actions";

export function OpenShiftForm() {
  const router = useRouter();
  const submitting = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const busy = isSubmitting || isRefreshing || confirmed;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    const cash = new FormData(event.currentTarget).get("openingCash");
    if (typeof cash !== "string" || !/^[0-9]+$/.test(cash)) {
      setError("Masukkan kas awal dalam angka rupiah utuh, tanpa tanda atau pemisah. Nilai 0 diperbolehkan.");
      return;
    }
    submitting.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await openShiftAction(cash);
      if (result.success) {
        // Do not use the action's shift snapshot: the server page reads fresh state.
        setConfirmed(true);
        startTransition(() => router.refresh());
        return;
      }
      setError(result.error);
      if (result.code === "REGISTER_OCCUPIED") {
        startTransition(() => router.refresh());
      }
    } catch {
      setError("Status pembukaan shift belum dapat dipastikan. Periksa koneksi, lalu coba lagi. Shift yang sudah terbuka akan dilanjutkan.");
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-busy={busy}>
      <fieldset disabled={busy} className="space-y-6">
        <legend className="sr-only">Buka shift</legend>
        <div>
          <label htmlFor="opening-cash" className="block text-lg font-semibold">Kas awal</label>
          <p id="cash-help" className="mt-2 text-base leading-relaxed text-[#62685c]">Jumlah uang tunai di laci saat mulai shift. Isi 0 jika tidak ada. Gunakan angka tanpa titik atau koma.</p>
          <div className="relative mt-4">
            <span aria-hidden="true" className="absolute top-1/2 left-4 -translate-y-1/2 text-xl text-[#62685c]">Rp</span>
            <input id="opening-cash" name="openingCash" type="text" inputMode="numeric" pattern="[0-9]+" autoComplete="off" required aria-invalid={error ? true : undefined} aria-describedby={error ? "cash-help shift-error" : "cash-help"} className="min-h-16 w-full rounded-lg border border-[#a8aea0] bg-white py-3 pr-4 pl-14 text-3xl tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-wait disabled:opacity-60" />
          </div>
        </div>
        <button type="submit" className="min-h-14 w-full rounded-lg bg-[#344631] px-5 py-3 text-lg font-semibold text-white hover:bg-[#293926] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e503c] disabled:cursor-wait disabled:opacity-70">{busy ? "Memproses..." : "Buka Shift"}</button>
      </fieldset>
      <div aria-live="polite" aria-atomic="true" className="mt-4">
        {error && <p id="shift-error" className="rounded-lg border border-[#e5c8c1] bg-[#fcf1ed] px-4 py-3 text-base text-[#8b3026]">{error}</p>}
        {busy && <p className="mt-3 text-sm text-[#62685c]">{confirmed ? "Shift terkonfirmasi. Memuat status register..." : "Memeriksa status register..."}</p>}
      </div>
      {/* Full reload is the fallback if the router refresh is interrupted. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      {confirmed && <a href="/" className="mt-2 inline-flex min-h-12 items-center rounded px-2 text-[#3e503c] underline focus-visible:outline-2 focus-visible:outline-offset-2">Muat ulang jika status belum berubah</a>}
    </form>
  );
}
