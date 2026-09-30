import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../../finance-navigation";
import { FinanceReportPanel } from "../../report-panel";
export default async function MonthlyPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  await requireFinanceManager();
  const { month } = await searchParams;
  return <><FinanceNavigation current="monthly" /><FinanceReportPanel key={month} mode="monthly" initialValue={month} /></>;
}
