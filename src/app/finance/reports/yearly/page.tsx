import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../../finance-navigation";
import { FinanceReportPanel } from "../../report-panel";
export default async function YearlyPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const actor = await requireFinanceManager();
  const { year } = await searchParams;
  return <><FinanceNavigation current="yearly" role={actor.role} /><FinanceReportPanel key={year} mode="yearly" initialValue={year} /></>;
}
