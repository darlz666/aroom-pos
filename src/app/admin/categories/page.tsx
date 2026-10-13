import Link from "next/link";
import { requireRole } from "@/lib/auth/authorization";
import { listCategoriesAction } from "@/lib/categories/actions";
import { CategoryWorkspace } from "./workspace";

export default async function CategoriesPage() {
  const actor = await requireRole("ADMIN");
  const initial = await listCategoriesAction();
  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-4 text-[#292e28] sm:p-6">
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
        <h1 className="text-3xl font-semibold">Kategori Menu</h1>
        <Link href="/admin" className="inline-flex min-h-14 items-center rounded-lg border px-5">Kembali ke Admin</Link>
      </header>
      <CategoryWorkspace key={actor.id} actorId={actor.id} initial={initial} />
    </div>
  </main>;
}
