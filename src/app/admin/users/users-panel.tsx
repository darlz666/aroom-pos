"use client";

import { useRef, useState, type FormEvent } from "react";
import { changeUserRoleAction, createUserAction, listUsersAction, setUserActiveAction } from "@/lib/users/actions";
import { userRoles, type ManagedUser } from "@/lib/users/domain";

type Initial = Awaited<ReturnType<typeof listUsersAction>>;
type Mutation = Awaited<ReturnType<typeof createUserAction>>;
const control = "min-h-14 rounded-lg border border-[#a8aea0] bg-white px-4 py-3 disabled:opacity-50";
const uncertain = "Status belum dapat dipastikan. Periksa koneksi dan muat ulang daftar pengguna sebelum mencoba lagi.";

export function UsersPanel({ actorId, initial }: { actorId: string; initial: Initial }) {
  const [users, setUsers] = useState<ManagedUser[]>(initial.success ? initial.users : []);
  const [error, setError] = useState(initial.success ? "" : initial.error);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(!initial.success);
  const inFlight = useRef(false);

  async function run(work: () => Promise<Mutation | Initial>, reload = false) {
    if (inFlight.current || (needsReload && !reload)) return false;
    inFlight.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await work();
      if (!result.success) {
        setError(result.error);
        if (reload || result.code === "UNAVAILABLE" || result.code === "DUPLICATE_LOGIN") setNeedsReload(true);
        return false;
      }
      if ("users" in result) { setUsers(result.users); setNeedsReload(false); }
      else setUsers(current => [...current.filter(user => user.id !== result.user.id), result.user]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
      setNotice(reload ? "Daftar pengguna diperbarui." : "Perubahan disimpan.");
      return true;
    } catch {
      setError(uncertain); setNeedsReload(true);
      return false;
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || needsReload) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = { name: data.get("name"), loginIdentifier: data.get("loginIdentifier"), password: data.get("password"), role: data.get("role") };
    // Do not retain credentials in component state or after submission.
    const password = form.elements.namedItem("password") as HTMLInputElement;
    password.value = "";
    if (await run(() => createUserAction(input))) form.reset();
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p>Kelola akun, role, dan status aktif pengguna.</p>
      <button type="button" className={control} disabled={busy} onClick={() => run(listUsersAction, true)}>Muat ulang daftar</button>
    </div>
    {error && <p role="alert" className="text-[#8b3026]">{error}</p>}
    <p role="status" aria-live="polite">{busy ? "Memproses…" : notice}</p>
    <form onSubmit={create} className="rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6">
      <h2 className="mb-4 text-xl font-semibold">Tambah pengguna</h2>
      <fieldset disabled={busy || needsReload} className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-2">Nama<input name="name" required maxLength={128} className={control} autoComplete="off" /></label>
        <label className="grid gap-2">Login<input name="loginIdentifier" required maxLength={128} className={control} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
        <label className="grid gap-2">Password (12–128 karakter)<input name="password" type="password" required className={control} autoComplete="new-password" /></label>
        <label className="grid gap-2">Role<select name="role" defaultValue="CASHIER" className={control}>{userRoles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
        <button type="submit" className={`${control} font-semibold`}>Tambah pengguna</button>
      </fieldset>
    </form>
    <section aria-label="Daftar pengguna" className="space-y-4" aria-busy={busy}>
      {!users.length && !needsReload && <p>Belum ada pengguna.</p>}
      {users.map(user => <article key={`${user.id}:${user.role}:${user.active}`} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6">
        <div className="min-w-0 break-words"><h2 className="text-xl font-semibold">{user.name}{user.id === actorId ? " (Anda)" : ""}</h2><p>{user.loginIdentifier}</p><p>{user.role} · {user.active ? "Aktif" : "Nonaktif"}</p></div>
        <fieldset disabled={busy || needsReload || user.id === actorId} className="flex flex-wrap items-end gap-3">
          <form onSubmit={event => {
            event.preventDefault();
            const role = new FormData(event.currentTarget).get("role");
            void run(() => changeUserRoleAction({ userId: user.id, role }));
          }} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-2">Role untuk {user.name}<select name="role" defaultValue={user.role} className={control}>{userRoles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
            <button type="submit" className={control}>Simpan role</button>
          </form>
          <button type="button" className={control} onClick={() => run(() => setUserActiveAction({ userId: user.id, active: !user.active }))}>{user.active ? "Nonaktifkan" : "Aktifkan"} {user.name}</button>
        </fieldset>
      </article>)}
    </section>
  </div>;
}
