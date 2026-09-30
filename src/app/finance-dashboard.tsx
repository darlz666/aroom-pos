import { requireRole } from "@/lib/auth/authorization";
import { FinanceReportPanel } from "./finance/report-panel";
export async function FinanceDashboard() {
  await requireRole("FINANCE");
  return <FinanceReportPanel mode="dashboard" />;
}
