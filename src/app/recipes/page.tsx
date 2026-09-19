import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRecipeReader } from "@/lib/auth/authorization";
import { logoutAction } from "@/lib/auth/actions";
import { listRecipeOptionsAction } from "@/lib/inventory/recipe-actions";
import { RecipeWorkspace } from "./recipe-workspace";

export default async function RecipesPage() {
  const actor = await requireRecipeReader();
  const initial = await listRecipeOptionsAction();
  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }
  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-4 text-[#292e28] sm:p-6">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#dedfd5] pb-5">
        <div><p className="text-sm font-semibold tracking-widest text-[#62685c]">AROOM COFFEE BAR</p><h1 className="text-3xl font-semibold">Resep &amp; HPP</h1></div>
        <nav className="flex flex-wrap items-center gap-4"><p>{actor.name}</p>
          {actor.role === "ADMIN" && <Link href="/admin" className="min-h-14 rounded-lg border px-5 py-4">Admin</Link>}
          {actor.role !== "FINANCE" && <Link href="/inventory" className="min-h-14 rounded-lg border px-5 py-4">Stock Management</Link>}
          <form action={logout}><button type="submit" className="min-h-14 rounded-lg border px-5">Logout</button></form>
        </nav>
      </header>
      <RecipeWorkspace key={actor.id} actorId={actor.id} canEdit={actor.role === "ADMIN" || actor.role === "STOCK_MANAGEMENT"} initial={initial} />
    </div>
  </main>;
}
