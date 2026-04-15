import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

const LINKS = [
  { href: "/help/install-macos", labelKey: "installMac" as const },
  { href: "/help/install-windows", labelKey: "installWin" as const },
  { href: "/help/chrome-extension", labelKey: "chrome" as const },
  { href: "/help/purchase-plan", labelKey: "purchase" as const },
  { href: "/terms", labelKey: "terms" as const },
  { href: "/privacy", labelKey: "privacy" as const },
];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/help",
    title: t("helpTitle"),
    description: t("helpDescription"),
  });
}

export default async function HelpHubPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  const t = await getTranslations("Help");
  const tNav = await getTranslations("Nav");

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--white)]">
      <header
        className="sticky top-0 z-50 border-b border-[var(--border)] backdrop-blur-md"
        style={{ background: "rgba(10,10,10,0.85)" }}
      >
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--white)]">
            ← {tNav("home")}
          </Link>
          <Link href="/" className="flex items-center gap-2">
            <img src="/assets/bloot.png" alt="bloot" className="h-[22px] w-auto mix-blend-screen" />
          </Link>
          <div className="w-12" />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-12 sm:px-6 sm:py-16">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("hubTitle")}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--muted)]">{t("hubSub")}</p>
        <ul className="mt-8 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          {LINKS.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex h-12 items-center justify-between px-4 text-[14px] text-[var(--muted)] transition hover:bg-[var(--surface2)] hover:text-[var(--white)]"
              >
                <span>{t(item.labelKey)}</span>
                <span aria-hidden className="text-[var(--muted2)]">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
          <h2 className="text-[15px] font-medium text-[var(--white)]">{t("supportTitle")}</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">{t("supportBody")}</p>
          <a
            href="https://t.me/blootsupport"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex rounded-lg bg-[var(--white)] px-4 py-2.5 text-[13px] font-semibold text-black transition hover:bg-[var(--accent)]"
          >
            {t("telegramCta")}
          </a>
        </div>
      </main>
    </div>
  );
}
