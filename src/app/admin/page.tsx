import { requireRole } from "@/lib/auth/authorization";
import Link from "next/link";

export default async function AdminPage() {
  const user = await requireRole("ADMIN");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">AROOM Admin</h1>
      <p className="text-lg">{user.name}</p>
      <Link href="/admin/users" className="mt-4 inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold">Access Management</Link>
      <Link href="/admin/reports" className="mt-4 inline-flex min-h-12 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-4">Laporan harian</Link>
      <Link href="/" className="mt-4 inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold">Kembali ke register</Link>
    </main>
  );
}
