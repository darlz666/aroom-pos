import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/lib/auth/actions";

const control = "inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-[#62716a] hover:bg-[#e8efea] aria-[current=page]:bg-[#e4eee7] aria-[current=page]:text-[#24634d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#24634d]";

export function FinanceNavigation({ current }: { current: "dashboard" | "report" | "monthly" | "yearly" | "expenses" }) {
  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }
  return <nav aria-label="Finance" className="flex flex-wrap gap-1">
    <Link href="/finance" aria-current={current === "dashboard" ? "page" : undefined} className={control}>Dashboard</Link>
    <Link href="/admin/reports" aria-current={current === "report" ? "page" : undefined} className={control}>Laporan Harian</Link>
    <Link href="/finance/reports/monthly" aria-current={current === "monthly" ? "page" : undefined} className={control}>Laporan Bulanan</Link>
    <Link href="/finance/reports/yearly" aria-current={current === "yearly" ? "page" : undefined} className={control}>Laporan Tahunan</Link>
    <Link href="/finance/expenses" aria-current={current === "expenses" ? "page" : undefined} className={control}>Pengeluaran</Link>
    <form action={logout}><button type="submit" className={control}>Keluar</button></form>
  </nav>;
}
