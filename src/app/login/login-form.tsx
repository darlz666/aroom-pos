"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { loginAction } from "@/lib/auth/actions";

export function LoginForm() {
  const router = useRouter();
  const submitting = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;

    const data = new FormData(event.currentTarget);
    submitting.current = true;
    setIsSubmitting(true);
    setError(null);

    try {
      const result = await loginAction(data.get("loginIdentifier"), data.get("password"));
      if (result.success) {
        router.replace("/");
        router.refresh();
        // Keep the form locked until navigation completes.
        return;
      }
      setError(result.error);
    } catch {
      setError("Login atau password salah.");
    }

    submitting.current = false;
    setIsSubmitting(false);
  }

  const inputClassName = "min-h-14 w-full rounded-lg border border-[#a8aea0] bg-white px-4 text-base text-[#292e28] placeholder:text-[#73796c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-wait disabled:opacity-60";

  return (
    <form onSubmit={handleSubmit} aria-busy={isSubmitting} className="mt-8">
      <fieldset disabled={isSubmitting} className="space-y-5">
        <legend className="sr-only">Login AROOM POS</legend>
        <div className="space-y-2">
          <label htmlFor="login-identifier" className="block text-sm font-semibold">Login</label>
          <input
            id="login-identifier"
            name="loginIdentifier"
            type="text"
            placeholder="Masukkan login"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-describedby={error ? "login-error" : undefined}
            className={inputClassName}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="login-password" className="block text-sm font-semibold">Password</label>
          <input
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            placeholder="Masukkan password"
            autoComplete="current-password"
            required
            aria-describedby={error ? "login-error" : undefined}
            className={inputClassName}
          />
          <button
            type="button"
            aria-controls="login-password"
            onClick={() => setShowPassword(!showPassword)}
            className="min-h-11 rounded px-1 text-sm font-medium text-[#3e503c] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3e503c] disabled:cursor-wait disabled:opacity-60"
          >
            {showPassword ? "Sembunyikan password" : "Tampilkan password"}
          </button>
        </div>

        <div aria-live="polite" aria-atomic="true">
          {error && <p id="login-error" className="rounded-lg border border-[#e5c8c1] bg-[#fcf1ed] px-4 py-3 text-sm text-[#8b3026]">{error}</p>}
        </div>

        <button
          type="submit"
          className="min-h-14 w-full rounded-lg bg-[#344631] px-5 py-3 text-base font-semibold text-white hover:bg-[#293926] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#3e503c] disabled:cursor-wait disabled:opacity-70"
        >
          {isSubmitting ? "Memproses..." : "Masuk"}
        </button>
      </fieldset>
      <p role="status" className="sr-only">{isSubmitting ? "Memproses..." : ""}</p>
    </form>
  );
}
