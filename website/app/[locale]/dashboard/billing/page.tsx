import { getDashboardViewer } from "@/lib/dashboard-server";
import { formatDate } from "@/lib/dashboard-ui";
import { QootiSubscriptionCards } from "@/components/dashboard/QootiSubscriptionCards";
import { ScrollToHash } from "@/components/dashboard/ScrollToHash";
import { getQootiPacksForLocale } from "@/lib/qooti-subscription-ui";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { PlanType } from "@/lib/dashboard";

function planLabelTranslated(plan: PlanType, tb: (key: string) => string) {
  if (plan === "monthly") return tb("planMonthly");
  if (plan === "biannual") return tb("planBiannual");
  if (plan === "yearly") return tb("planYearly");
  return tb("planTrial");
}

export default async function DashboardBillingPage() {
  const { user, apps, payments } = await getDashboardViewer();
  const t = await getTranslations("DashboardBilling");
  const locale = await getLocale();
  const { packs, benefits } = await getQootiPacksForLocale();
  const tb = await getTranslations("Billing");

  return (
    <div>
      <ScrollToHash />
      <h1 className="page-title">{t("title")}</h1>
      <section className="section-spacing space-y-3">
        <h2 className="section-label">{t("currentPlan")}</h2>
        {apps.map((app) => (
          <div key={app.appId} className="dashboard-card">
            <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-[var(--white)]">{app.appName}</p>
                <span className="mt-2 inline-flex rounded-full bg-[var(--surface2)] px-2 py-1 text-[11px] uppercase tracking-[0.06em] text-[var(--white)]">
                  {planLabelTranslated(app.planType, t)}
                </span>
              </div>
              <div className="text-[13px] text-[var(--muted)]">
                {t("expiryPrefix")}{" "}
                <span className="text-[var(--white)]">{formatDate(app.expiresAt, locale)}</span>
              </div>
              <div className="text-[13px] text-[var(--muted)]">${app.amountPaid.toFixed(2)}</div>
              <Link href="/dashboard/billing#plans" className="btn btn-primary">
                {t("extendPlan")}
              </Link>
            </div>
          </div>
        ))}
      </section>

      <QootiSubscriptionCards
        username={user.username}
        publicId={user.publicId}
        packs={packs}
        benefits={benefits}
        sectionTitle={tb("packagesTitle")}
        sectionSub={tb("packagesSub")}
        periodNote={tb("periodNote")}
        taxNote={tb("taxNote")}
        buyLabel={tb("buyNow")}
        bestValueLabel={tb("bestValue")}
      />

      <section className="section-spacing">
        <h2 className="section-label">{t("paymentHistory")}</h2>
        <div className="mt-3 overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--surface)]">
          {payments.length === 0 ? (
            <div className="flex min-h-[180px] items-center justify-center px-4 py-8 text-[13px] text-[var(--muted2)]">
              {t("noPayments")}
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="bg-[var(--surface2)] text-[11px] uppercase tracking-[0.06em] text-[var(--muted2)]">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("dateCol")}</th>
                  <th className="px-4 py-3 font-medium">{t("amountCol")}</th>
                  <th className="px-4 py-3 font-medium">{t("descriptionCol")}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((row, index) => (
                  <tr key={row.id} className={index === payments.length - 1 ? "" : "border-b border-[var(--border)]"}>
                    <td className="h-12 px-4 text-[var(--white)]">{formatDate(row.paidAt, locale)}</td>
                    <td className="h-12 px-4 text-[var(--white)]">${row.amount.toFixed(2)}</td>
                    <td className="h-12 px-4 text-[var(--muted)]">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
