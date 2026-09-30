import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceReportPanel } from "./finance/report-panel";
export async function FinanceDashboard() {
  const user = await requireFinanceManager();
  return <FinanceReportPanel mode="dashboard" canDelete={user.role === "ADMIN"} />;
}
