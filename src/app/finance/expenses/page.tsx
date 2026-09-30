import { requireFinanceManager } from "@/lib/auth/authorization";
import { FinanceNavigation } from "../../finance-navigation";
import { ExpensePanel } from "./expense-panel";
export default async function ExpensesPage() {
  const actor = await requireFinanceManager();
  return <><FinanceNavigation current="expenses" /><ExpensePanel actorId={actor.id} /></>;
}
