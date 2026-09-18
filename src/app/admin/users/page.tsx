import Link from "next/link";
import { requireRole } from "@/lib/auth/authorization";
import { listUsersAction } from "@/lib/users/actions";
import { UsersPanel } from "./users-panel";

export default async function UsersPage() {
  const actor = await requireRole("ADMIN");
  const initial = await listUsersAction();
  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-6 text-[#292e28] sm:p-10">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Access Management</h1>
        <Link href="/admin" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold">Kembali ke Admin</Link>
      </header>
      <UsersPanel actorId={actor.id} initial={initial} />
    </div>
  </main>;
}
