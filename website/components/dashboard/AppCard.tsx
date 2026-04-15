"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { DashboardApp, type PlanType } from "@/lib/dashboard";
import { formatDate, planBadgeClass } from "@/lib/dashboard-ui";

function daysRemaining(expiresAt: number) {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

function planLabel(plan: PlanType, tb: ReturnType<typeof useTranslations>) {
  if (plan === "monthly") return tb("planMonthly");
  if (plan === "biannual") return tb("planBiannual");
  if (plan === "yearly") return tb("planYearly");
  return tb("planTrial");
}

function CircleRing({
  totalDays,
  remainingDays,
  color,
  daysLabel,
}: {
  totalDays: number;
  remainingDays: number;
  color: string;
  daysLabel: string;
}) {
  const pct = totalDays <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((remainingDays / totalDays) * 100)));
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (pct / 100) * circumference;
  return (
    <div className="app-progress-wrap">
      <svg viewBox="0 0 100 100" className="app-progress-svg" aria-hidden="true">
        <circle cx="50" cy="50" r={radius} className="app-progress-track" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          className="app-progress-value"
          style={{ stroke: color, strokeDasharray: circumference, strokeDashoffset: dashOffset }}
        />
      </svg>
      <div className="app-progress-center">
        <span className="app-progress-days">{remainingDays}</span>
        <span className="app-progress-label">{daysLabel}</span>
      </div>
    </div>
  );
}

export function AppCard({ app, condensed = false }: { app: DashboardApp; condensed?: boolean }) {
  const t = useTranslations("Dashboard");
  const tb = useTranslations("DashboardBilling");
  const locale = useLocale();
  const remaining = daysRemaining(app.expiresAt);
  const total = Math.max(1, Math.ceil((app.expiresAt - app.startsAt) / (24 * 60 * 60 * 1000)));
  const planColor =
    app.planType === "yearly"
      ? "#4ade80"
      : app.planType === "biannual"
        ? "#c084fc"
        : app.planType === "monthly"
          ? "#4eabfb"
          : "#f59e0b";

  return (
    <article className="dashboard-card app-card">
      <div className="app-card-top">
        <div className="app-card-heading">
          <img src="/assets/app-icon.png" alt="" className="app-card-icon" />
          <div className="min-w-0">
            <h3 className="app-card-title">{app.appName}</h3>
            <p className="app-card-desc">{app.appDescription}</p>
          </div>
        </div>
        <span className={`app-plan-pill ${planBadgeClass(app.planType)}`}>{planLabel(app.planType, tb)}</span>
      </div>

      <div className="app-card-middle">
        <div className="app-card-dates">
          <div>
            <p className="section-label">{t("appStarted")}</p>
            <p className="app-date-text">{formatDate(app.startsAt, locale)}</p>
          </div>
          <div className="mt-4">
            <p className="section-label">{t("appEnds")}</p>
            <p className="app-date-text">{formatDate(app.expiresAt, locale)}</p>
          </div>
        </div>
        <CircleRing totalDays={total} remainingDays={remaining} color={planColor} daysLabel={t("daysLeft")} />
      </div>

      {!condensed ? (
        <div className="app-card-actions">
          <div className="app-card-actions-grid">
            <Link href="/download/thanks/macos" className="btn btn-secondary">
              {t("downloadMac")}
            </Link>
            <Link href="/download/thanks/windows" className="btn btn-secondary">
              {t("downloadWin")}
            </Link>
            <Link href="/dashboard/billing#plans" className="btn btn-primary">
              {t("extendPlanCta")}
            </Link>
          </div>
        </div>
      ) : null}
    </article>
  );
}
