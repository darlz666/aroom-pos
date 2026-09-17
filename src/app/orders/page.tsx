import Link from "next/link";
import { requireUser } from "@/lib/auth/authorization";
import { listOrderHistoryAction } from "@/lib/orders/actions";
import { OrderHistory } from "./order-history";

export default async function OrderHistoryPage() {
  await requireUser();
  const initial = await listOrderHistoryAction();
  return <main lang="id" className="flex flex-1 flex-col bg-[#f6f4ef] text-[#292e28] lg:h-dvh lg:flex-none">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-[#dedfd5] px-6 py-4">
      <div><p className="text-xl font-semibold tracking-widest">AROOM COFFEE BAR</p><h1 className="mt-1 text-2xl font-semibold">Riwayat pesanan</h1></div>
      <Link href="/" className="inline-flex min-h-12 items-center rounded-lg border border-[#a8aea0] px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">Kelola shift</Link>
    </header>
    <OrderHistory initial={initial} />
  </main>;
}
