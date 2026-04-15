import { AppCard } from "@/components/dashboard/AppCard";
import { BlootIdPanel } from "@/components/dashboard/BlootIdPanel";
import { getDashboardViewer } from "@/lib/dashboard-server";
import { formatDate } from "@/lib/dashboard-ui";
import type { PlanType } from "@/lib/dashboard";
import { getLocale, getTranslations } from "next-intl/server";

function planLabelTranslated(plan: PlanType, tb: (key: string) => string) {
  if (plan === "monthly") return tb("planMonthly");
  if (plan === "biannual") return tb("planBiannual");
  if (plan === "yearly") return tb("planYearly");
  return tb("planTrial");
}

export default async function DashboardOverviewPage() {
  const { user, apps } = await getDashboardViewer();
  const t = await getTranslations("Dashboard");
  const tb = await getTranslations("DashboardBilling");
  const locale = await getLocale();
  const activeApps = apps.length;
  const topPlan = apps[0]?.planType ?? "trial";

  return (
    <div>
      <h1 className="greeting-title">{t("greeting", { username: user.username })}</h1>
      <p className="page-subtitle">{t("pageSubtitle")}</p>

      <div className="section-spacing">
        <BlootIdPanel publicId={user.publicId} />

        <div className="metric-grid">
          <div className="dashboard-card">
            <p className="metric-label">{t("activePlan")}</p>
            <p className="metric-value">{planLabelTranslated(topPlan, tb)}</p>
          </div>
          <div className="dashboard-card">
            <p className="metric-label">{t("numActiveApps")}</p>
            <p className="metric-value">{activeApps}</p>
          </div>
          <div className="dashboard-card">
            <p className="metric-label">{t("memberSince")}</p>
            <p className="metric-value">{formatDate(user.createdAt, locale)}</p>
          </div>
        </div>
      </div>

      <section className="mt-9">
        <h2 className="section-label">{t("myAppsHeading")}</h2>
        <div className="app-grid-overview mt-3">
          {apps.map((app) => (
            <AppCard key={app.appId} app={app} />
          ))}
        </div>
      </section>
    </div>
  );
}
