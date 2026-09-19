import { redirect } from "next/navigation";
import Link from "next/link";
import { logoutAction } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/authorization";
import { getActiveShiftAction } from "@/lib/shifts/actions";
import { OpenShiftForm } from "./open-shift-form";
import { CloseShiftForm } from "./close-shift-form";

export default async function Home() {
  const user = await requireUser();

  async function logout() {
    "use server";
    await logoutAction();
    redirect("/login");
  }

  if (user.role === "STOCK_MANAGEMENT") redirect("/inventory");
  if (user.role === "FINANCE") {
    return <main lang="id" className="flex flex-1 flex-col items-center justify-center gap-6 bg-[#f6f4ef] p-8 text-center text-[#292e28]">
      <h1 className="text-3xl font-semibold">Finance</h1>
      <p className="text-lg">{user.name}</p>
      <Link href="/recipes" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold">Lihat resep &amp; HPP</Link>
      <form action={logout}><button type="submit" className="min-h-14 rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold">Logout</button></form>
    </main>;
  }
  const register = await getActiveShiftAction();

  return (
    <main lang="id" className="flex flex-1 flex-col bg-[#f6f4ef] px-6 py-6 text-[#292e28] sm:px-10">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b border-[#dedfd5] pb-6">
        <div>
          <p className="text-2xl font-semibold tracking-[0.12em]">AROOM POS</p>
          <p className="mt-1 text-xs tracking-[0.25em] text-[#62685c]">COFFEE BAR</p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          {user.role === "ADMIN" && <Link href="/admin" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold">Admin</Link>}
          <Link href="/orders" className="inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-4">Riwayat pesanan</Link>
          <div><p className="text-lg font-semibold break-words">{user.name}</p><p className="text-sm text-[#62685c]">{user.role}</p></div>
          <form action={logout}>
            <button type="submit" className="min-h-14 rounded-lg border border-[#a8aea0] px-6 py-3 font-semibold hover:bg-[#e9eade] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e503c]">Logout</button>
          </form>
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-5xl flex-1 content-center gap-8 py-10 md:grid-cols-2 md:items-center md:gap-16">
        <div>
          <p className="mb-4 text-sm font-semibold tracking-widest text-[#3e503c]">REGISTER AROOM</p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            {!register.success ? "Status shift belum tersedia" : register.state === "EMPTY" ? "Mulai shift Anda" : register.state === "OCCUPIED" ? "Register sedang digunakan" : "Shift Aktif"}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-[#62685c]">
            {!register.success ? "Periksa koneksi, lalu muat ulang halaman untuk melihat status terbaru." : register.state === "EMPTY" ? "Buka shift terlebih dahulu sebelum mulai berjualan." : register.state === "OCCUPIED" ? "Anda belum dapat mengoperasikan POS. Tunggu hingga shift aktif ditutup." : register.state === "ADMIN_VIEW" ? "Mode bantuan admin. ADMIN dapat mengoperasikan shift aktif ini. Pemilik shift tetap sama." : "Shift Anda aktif. POS dapat dioperasikan dengan shift ini."}
          </p>
          <p className="mt-6 text-sm leading-relaxed text-[#62685c]">Logout hanya mengakhiri sesi login dan tidak menutup shift.</p>
        </div>
        <section aria-label="Status register" className="min-w-0 rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 sm:p-8">
          {!register.success ? (
            // A full document reload must retry the server read, bypassing router cache.
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <div><p role="alert" className="text-[#8b3026]">{register.error}</p><a href="/" className="mt-5 inline-flex min-h-14 items-center rounded-lg border border-[#a8aea0] px-5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4">Muat ulang</a></div>
          ) : register.state === "EMPTY" ? (
            <OpenShiftForm />
          ) : (
            <>
              <dl className="space-y-6">
                <div><dt className="text-sm text-[#62685c]">Pemilik shift</dt><dd className="mt-1 break-words text-2xl font-semibold">{register.shift.ownerName}</dd></div>
                <div><dt className="text-sm text-[#62685c]">Waktu buka · WIB</dt><dd className="mt-1 text-xl"><time dateTime={register.shift.openedAt}>{new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "long", timeStyle: "short" }).format(new Date(register.shift.openedAt))}</time></dd></div>
                {register.state !== "OCCUPIED" && <div><dt className="text-sm text-[#62685c]">Kas awal</dt><dd className="mt-1 text-3xl font-semibold tabular-nums">Rp{new Intl.NumberFormat("id-ID").format(register.shift.openingCash)}</dd></div>}
              </dl>
              {(register.state === "OWNED" || register.state === "ADMIN_VIEW") && <CloseShiftForm key={register.shift.id} shiftId={register.shift.id} requiresAdminReason={register.state === "ADMIN_VIEW"} />}
              {register.state !== "OCCUPIED" && <Link href="/pos" className="mt-8 flex min-h-14 items-center justify-center rounded-lg bg-[#344631] px-5 py-3 text-lg font-semibold text-white hover:bg-[#293926] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e503c]">Buka POS</Link>}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
