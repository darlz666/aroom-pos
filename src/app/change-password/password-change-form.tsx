"use client";
import { useRef, useState, type FormEvent } from "react";
import { changePasswordAction } from "@/lib/auth/recovery-actions";
import { logoutAction } from "@/lib/auth/actions";
import { validatePassword } from "@/lib/auth/password-validation";
import Link from "next/link";
import { useRouter } from "next/navigation";

const control = "min-h-14 rounded-lg border border-[#a8aea0] px-4 py-3 disabled:opacity-50";
export function PasswordChangeForm({ mandatory }: { mandatory: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || uncertain) return;
    if (!navigator.onLine) { setMessage("Tidak ada koneksi. Perubahan tidak dikirim."); return; }
    const form = event.currentTarget, data = new FormData(form);
    const input = { currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"), confirmation: data.get("confirmation") };
    if (!validatePassword(input.newPassword) || input.newPassword !== input.confirmation) { setMessage("Gunakan 12–128 karakter, bukan hanya spasi, dengan konfirmasi yang sama."); return; }
    inFlight.current = true; setBusy(true); setMessage(""); form.reset();
    try {
      const result = await changePasswordAction(input);
      if (result.success) { router.replace("/login"); router.refresh(); return; }
      if (result.code === "UNAVAILABLE") setUncertain(true);
      setMessage(result.code === "EXPIRED" || result.code === "FORBIDDEN" ? "Sesi tidak berlaku. Login kembali atau hubungi Admin untuk reset baru." : result.code === "REAUTHENTICATE" ? "Password saat ini tidak sesuai." : "Perubahan ditolak atau hasil belum pasti. Jika koneksi terputus, login menggunakan password baru untuk memeriksa hasil.");
    } catch { setUncertain(true); setMessage("Hasil belum pasti. Jangan ulangi perubahan; login kembali menggunakan password baru untuk memeriksa hasil."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <div className="space-y-4">
    <p role="status">{message}</p>
    <form onSubmit={submit}><fieldset disabled={busy || uncertain} className="grid gap-4">
      {!mandatory && <label className="grid gap-2">Password saat ini<input className={control} name="currentPassword" type="password" autoComplete="current-password" required /></label>}
      <label className="grid gap-2">Password baru (12–128 karakter)<input className={control} name="newPassword" type="password" autoComplete="new-password" required /></label>
      <label className="grid gap-2">Konfirmasi password baru<input className={control} name="confirmation" type="password" autoComplete="new-password" required /></label>
      <button className={control} type="submit">Simpan dan login kembali</button>
    </fieldset></form>
    <button className={control} disabled={busy} onClick={async () => { if (inFlight.current) return; inFlight.current = true; setBusy(true); try { await logoutAction(); router.replace("/login"); router.refresh(); } catch { setMessage("Logout gagal. Coba kembali."); } finally { inFlight.current = false; setBusy(false); } }}>Keluar</button>
    {!mandatory && <Link href="/" className="inline-flex min-h-14 items-center">Kembali</Link>}
  </div>;
}
