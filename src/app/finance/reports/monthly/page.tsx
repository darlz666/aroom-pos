import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../../finance-navigation";
import { FinanceReportPanel } from "../../report-panel";
export default async function MonthlyPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const actor = await requireFinanceManager();
  const { month } = await searchParams;
  return <><FinanceNavigation current="monthly" role={actor.role} /><FinanceReportPanel key={month} mode="monthly" initialValue={month} /></>;
}
