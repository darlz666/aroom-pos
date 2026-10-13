"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { resetPasswordAction, resetStatusAction } from "@/lib/auth/recovery-actions";

type Status = Extract<Awaited<ReturnType<typeof resetStatusAction>>, { success: true }>["status"];
const control = "min-h-14 rounded-lg border border-[#a8aea0] px-4 py-3 disabled:opacity-50";
export function ResetPasswordPanel({ userId, name, close }: { userId: string; name: string; close: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const operation = useRef<{ operationId: string; expectedVersion: number } | null>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!secret || !status?.expiresAt) return;
    const timer = setTimeout(() => { setSecret(null); setMessage("Password sementara kedaluwarsa. Periksa status sebelum menerbitkan ulang."); }, Math.max(0, new Date(status.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [secret, status?.expiresAt]);
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setSecret(null); setResolved(false);
    try {
      const result = await resetStatusAction(userId, operation.current?.operationId);
      if (!mounted.current) return;
      if (result.success) {
        setStatus(result.status); setResolved(true);
        setMessage(result.status.operation === "APPLIED" ? "Reset tercatat. Password tidak dapat ditampilkan ulang; terbitkan ulang bila belum diterima." : "Status server diperbarui. Penerbitan baru membatalkan password sementara sebelumnya.");
      } else { setStatus(null); setMessage("Status belum tersedia atau akses ditolak. Jangan ulangi reset sebelum status diperiksa."); }
    } catch { if (mounted.current) setMessage("Koneksi gagal. Periksa status lagi."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !status || !resolved) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Reset tidak dikirim."); return; }
    const form = event.currentTarget, data = new FormData(form);
    const adminPassword = data.get("adminPassword"); form.reset();
    // A new issuance is always explicit and based on freshly inspected state.
    const intent = { operationId: crypto.randomUUID(), expectedVersion: status.credentialsVersion };
    operation.current = intent; inFlight.current = true; setBusy(true); setResolved(false); setSecret(null);
    try {
      const result = await resetPasswordAction({ ...intent, userId, adminPassword });
      if (!mounted.current) return;
      if (result.success) {
        setStatus(result.status); setSecret(result.temporaryPassword);
        setMessage(result.temporaryPassword ? "Reset berhasil. Serahkan secara pribadi. Tampilan ini tidak dapat dipulihkan setelah ditutup." : "Reset sudah tercatat. Password tidak dapat ditampilkan ulang.");
      } else {
        setMessage(result.code === "REAUTHENTICATE" ? "Password Admin tidak sesuai. Periksa status lalu coba kembali." : result.code === "STALE_VERSION" ? "Akun telah berubah. Periksa status terbaru." : "Reset ditolak atau hasil belum pasti. Periksa status server sebelum menerbitkan ulang.");
      }
    } catch { if (mounted.current) setMessage("Hasil belum pasti. Periksa status; jangan menganggap reset gagal."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Reset password" className="space-y-4 rounded-2xl border bg-[#fffefa] p-5">
    <h2 className="text-xl font-semibold">Reset password: {name}</h2>
    <p>Password acak berlaku 30 menit. Pegawai wajib menggantinya sebelum menggunakan aplikasi. Semua sesi lama dibatalkan.</p>
    <p role="status">{message}</p>
    {status && <p>Status: {status.state === "TEMPORARY" ? "Menunggu penggantian" : status.state === "EXPIRED" ? "Kedaluwarsa" : "Password biasa"}{status.expiresAt && ` · Batas waktu ${new Date(status.expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`}</p>}
    {secret && <div className="space-y-3 rounded-lg border p-4">
      <p>Rahasia — hanya untuk diserahkan kepada pegawai:</p><output className="block break-all font-mono text-lg">{secret}</output>
      <button className={control} onClick={async () => { try { await navigator.clipboard.writeText(secret); setMessage("Disalin atas permintaan Anda. Hapus clipboard setelah penyerahan."); } catch { setMessage("Tidak dapat menyalin. Serahkan secara pribadi dari tampilan ini."); } }}>Salin password</button>
      <button className={control} onClick={() => setSecret(null)}>Sembunyikan permanen</button>
    </div>}
    <button className={control} disabled={busy} onClick={() => void refresh()}>Periksa status server</button>
    <form onSubmit={submit} className="space-y-3">
      <fieldset disabled={busy || !resolved} className="grid gap-3">
        <label className="grid gap-2">Password Admin saat ini<input name="adminPassword" type="password" autoComplete="current-password" required className={control} /></label>
        <button className={control} type="submit">Terbitkan password sementara baru</button>
      </fieldset>
    </form>
    <button className={control} disabled={busy} onClick={close}>Tutup</button>
  </section>;
}
