import { redirect } from "next/navigation";
import { getPasswordChangeUser } from "@/lib/auth/current-user";
import { PasswordChangeForm } from "./password-change-form";

export default async function PasswordChangePage() {
  const user = await getPasswordChangeUser();
  if (!user) redirect("/login");
  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-4 text-[#292e28] sm:p-8">
    <section className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-[#fffefa] p-6">
      <h1 className="text-2xl font-semibold">Ganti password</h1>
      <p>{user.mustChangePassword ? "Anda wajib mengganti password sementara sebelum menggunakan aplikasi. Selesaikan sebelum batas waktu 30 menit." : "Masukkan password saat ini dan pilih password baru."}</p>
      <PasswordChangeForm mandatory={user.mustChangePassword} />
    </section>
  </main>;
}
