import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/lib/auth/actions";

const control = "inline-flex min-h-14 items-center justify-center rounded-lg border border-[#a8aea0] px-5 py-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-4";

export function FinanceNavigation({ current }: { current: "dashboard" | "report" }) {
  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }
  return <nav aria-label="Finance" className="flex flex-wrap gap-3">
    <Link href="/" aria-current={current === "dashboard" ? "page" : undefined} className={control}>Dashboard</Link>
    <Link href="/admin/reports" aria-current={current === "report" ? "page" : undefined} className={control}>Laporan Harian</Link>
    <form action={logout}><button type="submit" className={control}>Keluar</button></form>
  </nav>;
}
