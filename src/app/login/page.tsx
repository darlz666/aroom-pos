import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Masuk | AROOM POS",
};

export default function LoginPage() {
  return (
    <main lang="id" className="flex flex-1 items-center justify-center bg-[#f6f4ef] px-6 py-10 text-[#292e28] sm:px-10">
      <div className="grid w-full max-w-5xl gap-12 md:grid-cols-2 md:items-center md:gap-16 lg:gap-24">
        <header className="text-center md:text-left">
          <p className="text-5xl font-semibold tracking-[0.12em] sm:text-6xl">AROOM</p>
          <p className="mt-3 text-xs font-medium tracking-[0.38em]">COFFEE BAR</p>
          <div aria-hidden="true" className="mx-auto my-8 h-px w-12 bg-[#8b927f] md:mx-0" />
          <p className="text-sm tracking-wide text-[#62685c]">Point of Sale</p>
        </header>

        <section aria-labelledby="login-heading" className="w-full max-w-md justify-self-center rounded-2xl border border-[#dedfd5] bg-[#fffefa] p-6 sm:p-10">
          <h1 id="login-heading" className="text-3xl font-semibold tracking-tight">Selamat datang</h1>
          <p className="mt-3 text-base leading-relaxed text-[#62685c]">Masuk untuk menggunakan AROOM POS.</p>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
