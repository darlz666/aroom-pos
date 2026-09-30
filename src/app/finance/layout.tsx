import { requireFinanceManager } from "@/lib/auth/authorization";
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requireFinanceManager();
  return <main lang="id" className="min-w-0 flex-1 bg-[#f6f4ef] p-6 text-[#292e28] sm:p-10"><div className="mx-auto max-w-7xl space-y-6">{children}</div></main>;
}
