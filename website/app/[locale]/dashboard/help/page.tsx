import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

const GUIDES = [
  { href: "/help/install-macos", labelKey: "installMac" as const },
  { href: "/help/install-windows", labelKey: "installWin" as const },
  { href: "/help/chrome-extension", labelKey: "chrome" as const },
];

const LEGAL = [
  { href: "/terms", labelKey: "terms" as const },
  { href: "/privacy", labelKey: "privacy" as const },
];

export default async function DashboardHelpPage() {
  const t = await getTranslations("Help");

  return (
    <div className="flex min-h-[calc(100vh-180px)] items-center">
      <div className="grid w-full gap-4 lg:grid-cols-2">
        <div className="dashboard-card p-8">
          <div className="text-2xl">@</div>
          <h1 className="mt-4 text-[24px] font-semibold text-[var(--white)]">{t("supportTitle")}</h1>
          <p className="mt-3 text-[13px] text-[var(--muted)]">{t("supportBody")}</p>
          <a
            href="https://t.me/blootsupport"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary mt-6"
          >
            {t("telegramCta")}
          </a>
        </div>
        <div className="dashboard-card p-8">
          <h2 className="section-label">{t("linksTitle")}</h2>
          <div className="mt-3">
            {GUIDES.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex h-11 items-center justify-between border-b border-[var(--border)] text-[13px] text-[var(--muted)] transition last:border-none hover:bg-[var(--surface2)] hover:px-3 hover:text-[var(--white)]"
              >
                <span>{t(item.labelKey)}</span>
                <span aria-hidden>→</span>
              </Link>
            ))}
            <Link
              href="/dashboard/billing#plans"
              className="flex h-11 items-center justify-between border-b border-[var(--border)] text-[13px] text-[var(--muted)] transition hover:bg-[var(--surface2)] hover:px-3 hover:text-[var(--white)]"
            >
              <span>{t("purchase")}</span>
              <span aria-hidden>→</span>
            </Link>
            {LEGAL.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex h-11 items-center justify-between border-b border-[var(--border)] text-[13px] text-[var(--muted)] transition last:border-none hover:bg-[var(--surface2)] hover:px-3 hover:text-[var(--white)]"
              >
                <span>{t(item.labelKey)}</span>
                <span aria-hidden>→</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
