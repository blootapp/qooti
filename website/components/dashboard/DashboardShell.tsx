"use client";

import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ReactNode } from "react";

type UserMini = {
  username: string;
  publicId: string;
};

export function DashboardShell({
  user,
  planLabel,
  planClass,
  children,
}: {
  user: UserMini;
  planLabel: string;
  planClass: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("Dashboard");
  const tb = useTranslations("DashboardBilling");
  const initials =
    user.username
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "U";

  const nav = [
    { href: "/", label: t("home") },
    { href: "/dashboard", label: t("overview") },
    { href: "/dashboard/apps", label: t("myApps") },
    { href: "/dashboard/billing", label: t("billing") },
    { href: "/dashboard/settings", label: t("settings") },
    { href: "/dashboard/help", label: t("help") },
  ];

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <div className="dashboard-root">
      <aside className="dashboard-sidebar">
        <Link href="/" className="dashboard-logo flex items-center gap-2">
          <img src="/assets/bloot.png" alt="bloot" className="h-7 w-auto" />
        </Link>
        <div className="dashboard-profile">
          <div className="dashboard-profile-label">{tb("accountLabel")}</div>
          <div className="dashboard-avatar">{initials}</div>
          <div className="dashboard-username truncate">{user.username}</div>
          <div>
            <span className={`dashboard-plan-pill ${planClass}`}>{planLabel}</span>
          </div>
        </div>
        <nav className="dashboard-nav">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`dashboard-nav-item ${active ? "active" : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="dashboard-signout-wrap">
          <button type="button" onClick={signOut} className="dashboard-signout">
            {t("signOut")}
          </button>
        </div>
      </aside>

      <main className="dashboard-main">
        <div className="dashboard-content">{children}</div>
      </main>

      <nav className="mobile-nav">
        {nav.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`text-center text-[11px] ${active ? "text-[var(--accent)]" : "text-[var(--muted)]"}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
