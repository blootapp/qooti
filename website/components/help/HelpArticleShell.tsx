import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import "@/components/legal/legal-doc.css";

export async function HelpArticleShell({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("Help");

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--white)]">
      <header
        className="sticky top-0 z-50 border-b border-[var(--border)] backdrop-blur-md"
        style={{ background: "rgba(10,10,10,0.85)" }}
      >
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link href="/help" className="text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--white)]">
            ← {t("hubTitle")}
          </Link>
          <Link href="/" className="flex items-center gap-2">
            <img src="/assets/bloot.png" alt="bloot" className="h-[22px] w-auto mix-blend-screen" />
          </Link>
          <div className="w-12" />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">{children}</main>
    </div>
  );
}
