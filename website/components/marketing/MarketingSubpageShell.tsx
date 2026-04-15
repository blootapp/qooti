import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export async function MarketingSubpageShell({ children }: { children: ReactNode }) {
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
      <main>{children}</main>
    </div>
  );
}
