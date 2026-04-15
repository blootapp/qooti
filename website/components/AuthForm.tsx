"use client";

import { useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

type Purpose = "login" | "register";

export interface AuthFormProps {
  purpose: Purpose;
}

const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3 text-[13px] text-[var(--white)] placeholder:text-[var(--muted2)] focus:border-[var(--border-hover)] focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]";

function EyeOpenIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M9.34268 18.7819L7.41083 18.2642L8.1983 15.3254C7.00919 14.8874 5.91661 14.2498 4.96116 13.4534L2.80783 15.6067L1.39362 14.1925L3.54695 12.0392C2.35581 10.6103 1.52014 8.87466 1.17578 6.96818L3.14386 6.61035C3.90289 10.8126 7.57931 14.0001 12.0002 14.0001C16.4211 14.0001 20.0976 10.8126 20.8566 6.61035L22.8247 6.96818C22.4803 8.87466 21.6446 10.6103 20.4535 12.0392L22.6068 14.1925L21.1926 15.6067L19.0393 13.4534C18.0838 14.2498 16.9912 14.8874 15.8021 15.3254L16.5896 18.2642L14.6578 18.7819L13.87 15.8418C13.2623 15.9459 12.6376 16.0001 12.0002 16.0001C11.3629 16.0001 10.7381 15.9459 10.1305 15.8418L9.34268 18.7819Z" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.8827 19.2968C16.1814 20.3755 14.1638 21.0002 12.0003 21.0002C6.60812 21.0002 2.12215 17.1204 1.18164 12.0002C1.61832 9.62282 2.81932 7.5129 4.52047 5.93457L1.39366 2.80777L2.80788 1.39355L22.6069 21.1925L21.1927 22.6068L17.8827 19.2968ZM5.9356 7.3497C4.60673 8.56015 3.6378 10.1672 3.22278 12.0002C4.14022 16.0521 7.7646 19.0002 12.0003 19.0002C13.5997 19.0002 15.112 18.5798 16.4243 17.8384L14.396 15.8101C13.7023 16.2472 12.8808 16.5002 12.0003 16.5002C9.51498 16.5002 7.50026 14.4854 7.50026 12.0002C7.50026 11.1196 7.75317 10.2981 8.19031 9.60442L5.9356 7.3497ZM12.9139 14.328L9.67246 11.0866C9.5613 11.3696 9.50026 11.6777 9.50026 12.0002C9.50026 13.3809 10.6196 14.5002 12.0003 14.5002C12.3227 14.5002 12.6309 14.4391 12.9139 14.328ZM20.8068 16.5925L19.376 15.1617C20.0319 14.2268 20.5154 13.1586 20.7777 12.0002C19.8603 7.94818 16.2359 5.00016 12.0003 5.00016C11.1544 5.00016 10.3329 5.11773 9.55249 5.33818L7.97446 3.76015C9.22127 3.26959 10.5793 3.00016 12.0003 3.00016C17.3924 3.00016 21.8784 6.87992 22.8189 12.0002C22.5067 13.6998 21.8038 15.2628 20.8068 16.5925ZM11.7229 7.50857C11.8146 7.50299 11.9071 7.50016 12.0003 7.50016C14.4855 7.50016 16.5003 9.51488 16.5003 12.0002C16.5003 12.0933 16.4974 12.1858 16.4919 12.2775L11.7229 7.50857Z" />
    </svg>
  );
}

export function AuthForm({ purpose }: AuthFormProps) {
  const t = useTranslations("Auth");
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [registrationToken, setRegistrationToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [registerStep, setRegisterStep] = useState<1 | 2 | 3>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const title = purpose === "login" ? t("loginTitle") : t("registerTitle");
  const footerHref = purpose === "login" ? "/signup" : "/login";
  const footerLabel = purpose === "login" ? t("noAccount") : t("haveAccount");

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!username.trim()) {
      setError(t("errUsername"));
      return;
    }
    if (!email.trim()) {
      setError(t("errEmail"));
      return;
    }
    if (!acceptedTerms) {
      setError(t("termsError"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          purpose: "register",
          username: username.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("errSendCode"));
        return;
      }
      setRegisterStep(2);
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim().replace(/\D/g, "").slice(0, 6),
          purpose: "register",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("errInvalidCode"));
        return;
      }
      if (!(data as { registrationToken?: string }).registrationToken) {
        setError(t("errGeneric"));
        return;
      }
      setRegistrationToken(String((data as { registrationToken?: string }).registrationToken));
      setRegisterStep(3);
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError(t("errPasswordLen"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("errPasswordMatch"));
      return;
    }
    if (!registrationToken) {
      setError(t("errSession"));
      return;
    }
    if (!acceptedTerms) {
      setError(t("errTermsRegister"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationToken, password, acceptedTerms: true }),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("errGeneric"));
        return;
      }
      setSuccess(true);
      router.push("/dashboard");
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error || t("errGeneric"));
        return;
      }
      setSuccess(true);
      router.push("/dashboard");
    } catch {
      setError(t("errNetwork"));
    } finally {
      setLoading(false);
    }
  }

  const hint =
    purpose === "login"
      ? t("loginIdHint")
      : registerStep === 2
        ? t("codeHint")
        : registerStep === 3
          ? t("passwordHint")
          : t("emailCodeHint");

  if (success) {
    return (
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
        <p className="font-medium text-[var(--white)]">{t("splashIn")}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {purpose === "register" ? t("splashReady") : t("splashWelcome")}
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-[var(--accent)] hover:underline">
          {t("continueSite")}
        </Link>
      </div>
    );
  }

  return (
    <div
      className="w-full max-w-[380px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8"
      style={{ boxShadow: "0 2px 0 rgba(255,255,255,0.03) inset" }}
    >
      <h1 className="text-[22px] font-medium tracking-tight text-[var(--white)]">{title}</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">{hint}</p>

      {purpose === "login" ? (
        <form onSubmit={handleLogin} className="mt-6 space-y-4">
          <div>
            <label htmlFor="identifier" className="sr-only">
              {t("loginIdHint")}
            </label>
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              placeholder={t("placeholderBlot")}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div className="relative">
            <label htmlFor="password" className="sr-only">
              {t("password")}
            </label>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder={t("password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={inputClass + " pr-11"}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--white)] hover:opacity-80"
              aria-label={showPassword ? t("srHidePassword") : t("srShowPassword")}
            >
              {showPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeOpenIcon className="h-5 w-5" />}
            </button>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("wait") : t("loginBtn")}
          </button>
          <Link
            href="/forgot-password"
            className="block text-center text-xs text-[var(--muted)] hover:text-[var(--white)]"
          >
            {t("forgot")}
          </Link>
        </form>
      ) : registerStep === 2 ? (
        <form onSubmit={handleVerifyCode} className="mt-6 space-y-4">
          <div>
            <label htmlFor="code" className="sr-only">
              {t("codeHint")}
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t("codePlaceholder")}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              maxLength={6}
              required
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3 text-center text-lg tracking-[0.4em] text-[var(--white)] placeholder:text-[var(--muted2)] focus:border-[var(--border-hover)] focus:outline-none focus:ring-1 focus:ring-[var(--border-hover)]"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("verifying") : t("verify")}
          </button>
          <button
            type="button"
            onClick={() => {
              setRegisterStep(1);
              setError("");
              setCode("");
            }}
            className="w-full text-sm text-[var(--muted)] hover:text-[var(--white)]"
          >
            {t("differentEmail")}
          </button>
        </form>
      ) : registerStep === 3 ? (
        <form onSubmit={handleCreateAccount} className="mt-6 space-y-4">
          <p className="text-[13px] text-[var(--muted)]">
            {t("verifiedLine")} <span className="text-[var(--white)]">{email}</span>
          </p>
          <div className="relative">
            <label htmlFor="password" className="sr-only">
              {t("password")}
            </label>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t("placeholderPassMin")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className={inputClass + " pr-11"}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--white)] hover:opacity-80"
              aria-label={showPassword ? t("srHidePassword") : t("srShowPassword")}
            >
              {showPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeOpenIcon className="h-5 w-5" />}
            </button>
          </div>
          <div className="relative">
            <label htmlFor="confirmPassword" className="sr-only">
              {t("confirmPassword")}
            </label>
            <input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder={t("confirmPassword")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              className={inputClass + " pr-11"}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--white)] hover:opacity-80"
              aria-label={showConfirmPassword ? t("srHidePassword") : t("srShowPassword")}
            >
              {showConfirmPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeOpenIcon className="h-5 w-5" />}
            </button>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("creating") : t("createAccount")}
          </button>
        </form>
      ) : (
        <form onSubmit={handleSendCode} className="mt-6 space-y-4">
          <div>
            <label htmlFor="username" className="sr-only">
              {t("username")}
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              placeholder={t("username")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="email" className="sr-only">
              {t("email")}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t("email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-3 text-[13px] leading-snug text-[var(--muted)]">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => {
                setAcceptedTerms(e.target.checked);
                if (e.target.checked) setError("");
              }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--border)] bg-[var(--surface2)] accent-[var(--accent)]"
            />
            <span>
              {t("termsCheck")}{" "}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] underline underline-offset-2 hover:opacity-90"
                onClick={(e) => e.stopPropagation()}
              >
                {t("termsLink")}
              </Link>
              {t("termsCheckEnd") ? ` ${t("termsCheckEnd")}` : ""}
            </span>
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !acceptedTerms}
            className="w-full rounded-lg bg-[var(--white)] py-3 text-[13px] font-medium text-black transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {loading ? t("sendingCodeShort") : t("sendCode")}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-[12.5px] text-[var(--muted2)]">
        <Link href={footerHref} className="text-[var(--muted)] transition-colors hover:text-[var(--white)]">
          {footerLabel}
        </Link>
      </p>
    </div>
  );
}
