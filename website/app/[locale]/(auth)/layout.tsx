import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { RedirectIfLoggedIn } from "@/components/RedirectIfLoggedIn";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tNav = await getTranslations("Nav");

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <RedirectIfLoggedIn />
      <nav
        className="fixed top-0 right-0 left-0 z-50 flex h-14 items-center justify-between border-b border-[var(--border)] px-6 backdrop-blur-md"
        style={{ background: "rgba(10,10,10,0.75)" }}
      >
        <Link
          href="/"
          className="text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--white)]"
        >
          ← {tNav("home")}
        </Link>
        <Link href="/" className="flex items-center gap-2">
          <img src="/assets/bloot.png" alt="bloot" className="h-[22px] w-auto mix-blend-screen" />
        </Link>
        <div className="w-12" />
      </nav>
      <main className="flex min-h-screen flex-col items-center justify-center px-6 pt-14">{children}</main>
    </div>
  );
}
