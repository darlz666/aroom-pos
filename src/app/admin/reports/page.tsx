import Link from "next/link";
import { requireRole } from "@/lib/auth/authorization";
import { getDailyReportAction } from "@/lib/reports/action";
import { jakartaBusinessDate } from "@/lib/reports/domain";
import { DailyReportPanel } from "./daily-report";

export default async function ReportsPage() {
  await requireRole("ADMIN");
  const date = jakartaBusinessDate();
  const initial = await getDailyReportAction(date);
  return <main lang="id" className="flex-1 bg-[#f6f4ef] p-6 text-[#292e28] sm:p-10">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Laporan harian</h1>
        <Link href="/admin" className="inline-flex min-h-12 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold">Kembali ke Admin</Link>
      </header>
      <DailyReportPanel initialDate={date} initial={initial} />
    </div>
  </main>;
}
