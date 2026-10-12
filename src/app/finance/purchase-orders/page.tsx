import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../finance-navigation";
import { PurchaseOrderWorkspace } from "../../inventory/purchase-orders/workspace";

export default async function FinancePurchaseOrdersPage() {
  const user = await requireFinanceManager();
  return <section className="min-w-0 space-y-6"><h1 className="text-2xl font-semibold">Persetujuan PO bahan</h1>
    <FinanceNavigation current="purchase-orders" role={user.role} />
    <PurchaseOrderWorkspace key={user.id} role={user.role} actorId={user.id} approvals />
  </section>;
}
