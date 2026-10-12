import Link from "next/link";
import { requireInventoryManager } from "@/lib/auth/authorization";
import { PurchaseOrderWorkspace } from "./workspace";

export default async function InventoryPurchaseOrdersPage() {
  const user = await requireInventoryManager();
  return <main lang="id" className="min-w-0 flex-1 bg-[#f6f4ef] p-4 text-[#292e28] sm:p-6"><div className="mx-auto min-w-0 max-w-7xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm tracking-widest">AROOM COFFEE BAR</p><h1 className="text-2xl font-semibold">Pesanan pembelian bahan</h1></div><Link className="inline-flex min-h-12 items-center underline" href="/inventory">Kembali ke inventori</Link></header>
    <PurchaseOrderWorkspace key={user.id} role={user.role} actorId={user.id} />
  </div></main>;
}
