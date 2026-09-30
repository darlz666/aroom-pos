import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceReportPanel } from "./finance/report-panel";
export async function FinanceDashboard() {
  await requireFinanceManager();
  return <FinanceReportPanel mode="dashboard" />;
}
