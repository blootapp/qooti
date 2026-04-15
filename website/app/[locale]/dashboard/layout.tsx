import { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { getDashboardViewer } from "@/lib/dashboard-server";
import { planBadgeClass } from "@/lib/dashboard-ui";
import type { PlanType } from "@/lib/dashboard";
import { buildNoIndexMetadata } from "@/lib/seo/metadata";
import "./dashboard.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildNoIndexMetadata({
    title: t("dashboardTitle"),
    description: t("dashboardDescription"),
  });
}

function planLabelTranslated(plan: PlanType, tb: (key: string) => string) {
  if (plan === "monthly") return tb("planMonthly");
  if (plan === "biannual") return tb("planBiannual");
  if (plan === "yearly") return tb("planYearly");
  return tb("planTrial");
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, apps } = await getDashboardViewer();
  const tb = await getTranslations("DashboardBilling");
  const topPlan = apps[0]?.planType ?? "trial";

  return (
    <DashboardShell
      user={{ username: user.username, publicId: user.publicId }}
      planLabel={planLabelTranslated(topPlan, tb)}
      planClass={planBadgeClass(topPlan)}
    >
      {children}
    </DashboardShell>
  );
}
