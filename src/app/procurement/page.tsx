import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcurementManager } from "@/lib/auth/authorization";
import { logoutAction } from "@/lib/auth/actions";
import { ProcurementWorkspace } from "./workspace";

export default async function ProcurementPage() {
  const user = await requireProcurementManager();
  async function logout() { "use server"; await logoutAction(); redirect("/login"); }
  return <main className="min-w-0 flex-1 bg-[#f6f4ef] px-4 py-6 text-[#292e28] sm:p-6 lg:p-8">
    <div className="mx-auto w-full min-w-0 max-w-7xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#dce1d7] pb-6"><div className="min-w-0 space-y-2"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">AROOM Coffee Bar / Pengadaan</h1><p className="text-sm text-[#62685c] [overflow-wrap:anywhere]">{user.name}{user.role === "ADMIN" ? " · Hanya dapat melihat" : ""}</p></div>
      <nav className="flex gap-4">{user.role === "ADMIN" && <Link className="min-h-14 p-3" href="/admin">Menu Admin</Link>}<form action={logout}><button className="min-h-14 rounded-lg border px-5">Keluar</button></form></nav>
    </header>
    <ProcurementWorkspace role={user.role} actorId={user.id} />
    </div>
  </main>;
}
