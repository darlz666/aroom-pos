import { requireRole } from "@/lib/auth/authorization";

export default async function AdminPage() {
  const user = await requireRole("ADMIN");

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">AROOM Admin</h1>
      <p className="text-lg">{user.name}</p>
      <p className="mt-4 text-sm text-neutral-600">System setup in progress</p>
    </main>
  );
}
