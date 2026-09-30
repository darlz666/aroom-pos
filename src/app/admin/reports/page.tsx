import Link from "next/link";
import { requireReportReader } from "@/lib/auth/authorization";
import { getDailyReportAction } from "@/lib/reports/action";
import { businessDateRange, jakartaBusinessDate } from "@/lib/reports/domain";
import { DailyReportPanel } from "./daily-report";
import { FinanceNavigation } from "../../finance-navigation";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ date?: string }> } = { searchParams: Promise.resolve({}) }) {
  const actor = await requireReportReader();
  const requested = (await searchParams).date;
  let date = jakartaBusinessDate();
  if (requested) { try { date = businessDateRange(requested).businessDate; } catch { /* Controlled report action handles invalid input. */ date = requested; } }
  const initial = await getDailyReportAction(date);
  return <main lang="id" className="min-w-0 flex-1 bg-[#f6f4ef] p-6 text-[#292e28] sm:p-10">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Laporan harian</h1>
        {actor.role === "FINANCE" ? <FinanceNavigation current="report" /> : <Link href={actor.role === "ADMIN" ? "/admin" : "/"} className="inline-flex min-h-12 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold">Kembali</Link>}
      </header>
      <DailyReportPanel key={date} initialDate={date} initial={initial} role={actor.role} />
    </div>
  </main>;
}
