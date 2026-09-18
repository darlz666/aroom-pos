import Link from "next/link";
import { requireOperator } from "@/lib/auth/authorization";
import { getActiveShiftAction } from "@/lib/shifts/actions";
import { prisma } from "@/lib/db";
import { PosMenu, type MenuCategory } from "./pos-menu";
import { SettlementPanel } from "./settlement-panel";

export default async function PosPage() {
  const user = await requireOperator();
  const register = await getActiveShiftAction();
  const canOperate = register.success && (register.state === "OWNED" || register.state === "ADMIN_VIEW");
  let categories: MenuCategory[] | null = null;
  if (canOperate) {
    try {
      categories = await prisma.category.findMany({
        where: { active: true },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }, { id: "asc" }],
        select: {
          id: true, name: true,
          products: {
            where: { active: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            select: { id: true, name: true, price: true, available: true },
          },
        },
      });
    } catch {
      // Fail closed without exposing database details or a misleading empty menu.
    }
  }

  return (
    <main lang="id" className="flex flex-1 flex-col bg-[#f6f4ef] text-[#292e28] lg:h-dvh lg:flex-none">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#dedfd5] px-4 py-4 sm:px-6">
        <div><p className="text-xl font-semibold tracking-widest">AROOM <span className="text-sm tracking-normal">COFFEE BAR</span></p><h1 className="mt-1 text-sm text-[#62685c]">POS · {user.name}</h1></div>
        <div className="flex flex-wrap gap-3">
          {canOperate && register.success && register.shift && <SettlementPanel key={register.shift.id} shiftId={register.shift.id} />}
          <Link href="/" className="inline-flex min-h-12 items-center rounded-lg border border-[#a8aea0] px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2">Kelola shift</Link>
        </div>
      </header>
      {canOperate && register.success && register.shift && (
        <div className="shrink-0 border-b border-[#dedfd5] bg-[#e9eade] px-4 py-3 text-sm sm:px-6">
          <p className="break-words"><strong>Shift aktif</strong> · {register.shift.ownerName} · Dibuka <time dateTime={register.shift.openedAt}>{new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "medium", timeStyle: "short" }).format(new Date(register.shift.openedAt))}</time> WIB</p>
          {register.state === "ADMIN_VIEW" && <p className="mt-1">Mode bantuan admin. Pemilik shift tetap sama.</p>}
        </div>
      )}
      {!canOperate ? (
        <section className="m-auto max-w-lg p-6">
          <h2 className="text-2xl font-semibold">{!register.success ? "Status shift belum tersedia" : register.state === "OCCUPIED" ? "Register sedang digunakan" : "Buka shift terlebih dahulu"}</h2>
          <p className="mt-4 text-lg text-[#62685c]">{!register.success ? "Periksa koneksi dan muat ulang halaman untuk mencoba lagi." : register.state === "OCCUPIED" ? "Anda hanya dapat menggunakan POS pada shift Anda sendiri. Tunggu hingga shift aktif ditutup, lalu buka shift Anda melalui Kelola shift." : "Buka shift melalui Kelola shift sebelum menggunakan POS."}</p>
        </section>
      ) : categories === null ? (
        <section role="alert" className="m-auto max-w-lg p-6"><h2 className="text-2xl font-semibold">Menu belum dapat dimuat</h2><p className="mt-4">Periksa koneksi dan muat ulang halaman untuk mencoba lagi.</p></section>
      ) : <PosMenu key={register.success ? register.shift?.id : undefined} categories={categories} />}
    </main>
  );
}
