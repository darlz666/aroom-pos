import { Suspense } from "react";
import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceDashboard } from "../finance-dashboard";
import { FinanceNavigation } from "../finance-navigation";

export default async function FinancePage() {
  const actor = await requireFinanceManager();

  return <>
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#e2e7e3] pb-5">
      <div><p className="text-lg font-semibold tracking-tight">AROOM Coffee Bar</p><p className="mt-1 text-xs font-medium tracking-wide text-[#62716a]">Finance</p></div>
      <FinanceNavigation current="dashboard" role={actor.role} />
    </header>
    <Suspense fallback={<p role="status">Memuat laporan…</p>}><FinanceDashboard /></Suspense>
  </>;
}
