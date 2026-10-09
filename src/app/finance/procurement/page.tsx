import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../finance-navigation";
import { ProcurementWorkspace } from "../../procurement/workspace";

export default async function FinanceProcurementPage() {
  const user = await requireFinanceManager();
  return <main className="min-w-0 flex-1 bg-[#f6f4ef] px-4 py-6 text-[#292e28] sm:p-6 lg:p-8">
    <div className="mx-auto w-full min-w-0 max-w-7xl space-y-6">
    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Persetujuan Pengadaan</h1>
    <FinanceNavigation current="procurement" role={user.role} />
    <ProcurementWorkspace role={user.role} actorId={user.id} approvals />
    </div>
  </main>;
}
