"use client";

import { useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3 text-[13px] text-[var(--white)] placeholder:text-[var(--muted2)] focus:border-[var(--border-hover)] focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]";

export function ForgotPasswordForm() {
  const t = useTranslations("Auth");
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("forgotErrSend"));
        return;
      }
      setStep(2);
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("forgotErrVerify"));
        return;
      }
      setToken(String((data as { passwordResetToken?: string }).passwordResetToken || ""));
      setStep(3);
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError(t("errPasswordLen"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("errPasswordMatch"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passwordResetToken: token, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("forgotErrReset"));
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login"), 700);
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  const body =
    step === 1 ? t("forgotStep1Body") : step === 2 ? t("forgotStep2Body") : t("forgotStep3Body");

  return (
    <div className="w-full max-w-[380px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8">
      <h1 className="text-[22px] font-medium tracking-tight text-[var(--white)]">{t("forgotTitle")}</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">{body}</p>

      {done ? (
        <p className="mt-6 text-sm text-emerald-400">{t("forgotDoneRedirect")}</p>
      ) : step === 1 ? (
        <form onSubmit={sendCode} className="mt-6 space-y-4">
          <input
            className={inputClass}
            type="email"
            placeholder={t("email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("forgotSending") : t("forgotSendBtn")}
          </button>
        </form>
      ) : step === 2 ? (
        <form onSubmit={verifyCode} className="mt-6 space-y-4">
          <input
            className={inputClass + " text-center tracking-[0.3em]"}
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder={t("codePlaceholder")}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("forgotVerifying") : t("forgotVerifyBtn")}
          </button>
        </form>
      ) : (
        <form onSubmit={resetPassword} className="mt-6 space-y-4">
          <input
            className={inputClass}
            type="password"
            placeholder={t("placeholderPassMin")}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
          />
          <input
            className={inputClass}
            type="password"
            placeholder={t("confirmPassword")}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("forgotUpdating") : t("forgotResetBtn")}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-[12.5px] text-[var(--muted2)]">
        <Link href="/login" className="text-[var(--muted)] transition-colors hover:text-[var(--white)]">
          {t("forgotBackLogin")}
        </Link>
      </p>
    </div>
  );
}
