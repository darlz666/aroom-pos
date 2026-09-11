import { redirect } from "next/navigation";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/authorization";

export default async function Home() {
  const user = await requireUser();

  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">AROOM POS</h1>
      <p className="text-lg">{user.name}</p>
      <p>{user.role}</p>
      <p className="mt-4 text-sm text-neutral-600">System setup in progress</p>
      <form action={logout}>
        <button type="submit" className="mt-4 min-h-14 rounded-lg bg-neutral-800 px-6 py-3 text-white focus-visible:outline-2 focus-visible:outline-offset-4">
          Logout
        </button>
      </form>
    </main>
  );
}
