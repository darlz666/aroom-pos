"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  changeUserRoleAction,
  createUserAction,
  deleteUserAction,
  listUsersAction,
  resetUserPasswordAction,
  setUserActiveAction,
  updateUserAction,
} from "@/lib/users/actions";
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
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [editTarget, setEditTarget] = useState<ManagedUser | null>(null);
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

  async function updateAccount(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();

  if (!editTarget || inFlight.current || needsReload) return;

  const data = new FormData(event.currentTarget);

  const success = await run(() =>
    updateUserAction({
      userId: editTarget.id,
      name: data.get("name"),
      loginIdentifier: data.get("loginIdentifier"),
    })
  );

  if (success) {
    setEditTarget(null);
    setNotice("Data akun berhasil diperbarui.");
  }
}

  async function resetPassword(user: ManagedUser) {
  if (inFlight.current || needsReload) return;

  inFlight.current = true;
  setBusy(true);
  setError("");
  setNotice("");

  try {
    const result = await resetUserPasswordAction({
      userId: user.id,
    });

    if (!result.success) {
      setError(result.error);
      if (result.code === "UNAVAILABLE") {
        setNeedsReload(true);
      }
      return;
    }

    setResetTarget(null);
    setNotice("Password berhasil direset menjadi Masuk123!");
  } catch {
    setError(uncertain);
    setNeedsReload(true);
  } finally {
    inFlight.current = false;
    setBusy(false);
  }
}

async function removeUser(user: ManagedUser) {
  if (inFlight.current || needsReload || user.id === actorId) return;

  inFlight.current = true;
  setBusy(true);
  setError("");
  setNotice("");

  try {
    const result = await deleteUserAction({
      userId: user.id,
    });

    if (!result.success) {
      setError(result.error);

      if (result.code === "UNAVAILABLE") {
        setNeedsReload(true);
      }

      return;
    }

    setDeleteTarget(null);

    if (result.result.outcome === "DELETED") {
      setUsers(current =>
        current.filter(row => row.id !== user.id)
      );

      setNotice("Akun berhasil dihapus.");
    } else {
      const archivedUser = result.result.user;

      if (!archivedUser) {
        setError(
          "Data pengguna terbaru belum tersedia. Muat ulang daftar pengguna."
        );
        setNeedsReload(true);
        return;
      }

      setUsers(current =>
        current.map(row =>
          row.id === archivedUser.id
            ? archivedUser
            : row
        )
      );

      setNotice(
        "Akun dinonaktifkan karena memiliki riwayat aktivitas."
      );
    }
  } catch {
    setError(uncertain);
    setNeedsReload(true);
  } finally {
    inFlight.current = false;
    setBusy(false);
  }
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
        <label className="grid gap-2">Password (9–128 karakter)<input name="password" type="password" required className={control} autoComplete="new-password" /></label>
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
        <div className="flex flex-wrap gap-3">

  <button
  type="button"
  className={control}
  disabled={busy || needsReload}
  onClick={() => setEditTarget(user)}>
  Edit Akun
  </button>

  <button
    type="button"
    className={control}
    disabled={busy || needsReload}
    onClick={() => setResetTarget(user)}
  >
    Reset Password
  </button>

  <button
    type="button"
    className="min-h-14 rounded-lg border border-[#8b3026] bg-[#fffefa] px-4 py-3 font-semibold text-[#8b3026] disabled:opacity-50"
    disabled={busy || needsReload || user.id === actorId}
    onClick={() => setDeleteTarget(user)}
  >
    Hapus Akun
  </button>

  {editTarget && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <section className="w-full max-w-md rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 shadow-2xl">
      <h2 className="text-2xl font-semibold">
        Edit Akun
      </h2>

      <p className="mt-2 text-sm text-[#62685c]">
        Perbarui nama dan login pengguna.
      </p>

      <form onSubmit={updateAccount} className="mt-6 space-y-4">
        <label className="grid gap-2">
          Nama
          <input
            name="name"
            required
            maxLength={128}
            defaultValue={editTarget.name}
            className={control}
            autoComplete="off"
          />
        </label>

        <label className="grid gap-2">
          Login
          <input
            name="loginIdentifier"
            required
            maxLength={128}
            defaultValue={editTarget.loginIdentifier}
            className={control}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>

        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <button
            type="button"
            className={control}
            disabled={busy}
            onClick={() => setEditTarget(null)}
          >
            Batal
          </button>

          <button
            type="submit"
            className={`${control} font-semibold`}
            disabled={busy}
          >
            {busy ? "Memproses…" : "Simpan Perubahan"}
          </button>
        </div>
      </form>
    </section>
  </div>
)}

  {resetTarget && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <section className="w-full max-w-md rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 shadow-2xl">
      <h2 className="text-2xl font-semibold">
        Reset Password
      </h2>

      <p className="mt-3 text-[#62685c]">
        Password akun <strong>{resetTarget.name}</strong> akan
        direset menjadi:
      </p>

      <p className="mt-4 rounded-lg bg-[#f0eee8] p-4 text-xl font-semibold">
        Masuk123!
      </p>

      <p className="mt-3 text-sm text-[#62685c]">
        Password lama tidak dapat digunakan lagi setelah reset.
      </p>

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          className={control}
          disabled={busy}
          onClick={() => setResetTarget(null)}
        >
          Batal
        </button>

        <button
          type="button"
          className={`${control} font-semibold`}
          disabled={busy}
          onClick={() => void resetPassword(resetTarget)}
        >
          {busy ? "Memproses…" : "Reset Password"}
        </button>
      </div>
    </section>
  </div>
)}

{deleteTarget && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <section className="w-full max-w-md rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 shadow-2xl">
      <h2 className="text-2xl font-semibold text-[#8b3026]">
        Hapus Akun
      </h2>

      <p className="mt-3 text-[#62685c]">
        Anda akan menghapus akun{" "}
        <strong>{deleteTarget.name}</strong>.
      </p>

      <p className="mt-4 text-sm text-[#62685c]">
        Jika akun belum memiliki riwayat aktivitas, akun akan
        dihapus permanen. Jika sudah memiliki riwayat transaksi
        atau aktivitas, akun hanya akan dinonaktifkan agar histori
        tetap aman.
      </p>

      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          className={control}
          disabled={busy}
          onClick={() => setDeleteTarget(null)}
        >
          Batal
        </button>

        <button
          type="button"
          className="min-h-14 rounded-lg bg-[#8b3026] px-5 py-3 font-semibold text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void removeUser(deleteTarget)}
        >
          {busy ? "Memproses…" : "Hapus Akun"}
        </button>
      </div>
    </section>
  </div>
)}
</div>
      </article>)}
    </section>
  </div>;
}
