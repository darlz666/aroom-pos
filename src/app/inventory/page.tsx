import Link from "next/link";
import { redirect } from "next/navigation";
import { requireInventoryManager } from "@/lib/auth/authorization";
import { logoutAction } from "@/lib/auth/actions";
import { 
  listIngredientsAction,
  listStockInsAction,
  listSuppliersAction,
  listStockMovementsAction
} from "@/lib/inventory/actions";
import { InventoryWorkspace } from "./inventory-workspace";
import { StockMovementHistory } from "./stock-movement-history";

export default async function InventoryPage() {
  const actor = await requireInventoryManager();
  const [ingredients, suppliers, history, movements] = await Promise.all([
  listIngredientsAction(),
  listSuppliersAction(),
  listStockInsAction(),
  listStockMovementsAction()
]);
  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }

  const safeMovements = movements.success
  ? {
      ...movements,
      movements: movements.movements.map((movement) => ({
        ...movement,
        quantity: movement.quantity.toString(),
        stockAfter: movement.stockAfter.toString(),
        createdAt: movement.createdAt.toISOString(),
      })),
    }
  : movements;



  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-4 text-[#292e28] sm:p-6">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#dedfd5] pb-5">
        <div><p className="text-sm font-semibold tracking-widest text-[#62685c]">AROOM COFFEE BAR</p><h1 className="text-3xl font-semibold">Stock Management</h1></div>
        <div className="flex flex-wrap items-center gap-4"><p>{actor.name}</p>
          <Link href="/recipes" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold">Resep &amp; HPP</Link>
          {actor.role === "ADMIN" && <Link href="/admin" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold">Admin</Link>}
          <form action={logout}><button className="min-h-14 rounded-lg border border-[#a8aea0] px-5 font-semibold" type="submit">Logout</button></form>
        </div>
      </header>
      <InventoryWorkspace
      key={actor.id}
      actorId={actor.id}
      initialIngredients={ingredients}
      initialSuppliers={suppliers}
      initialHistory={history}
      initialMovements={safeMovements}
    />
  
    </div>
  </main>;
}
