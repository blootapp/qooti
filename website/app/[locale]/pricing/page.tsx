import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { MarketingRevealInit } from "@/components/marketing/MarketingRevealInit";
import { MarketingSubpageShell } from "@/components/marketing/MarketingSubpageShell";
import { PricingPageView } from "@/components/marketing/PricingPageView";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/pricing",
    title: t("pricingTitle"),
    description: t("pricingDescription"),
  });
}

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  return (
    <MarketingSubpageShell>
      <MarketingRevealInit />
      <div className="pt-6">
        <PricingPageView />
      </div>
    </MarketingSubpageShell>
  );
}
