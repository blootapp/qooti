import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { DownloadSection } from "@/components/marketing/DownloadSection";
import { MarketingRevealInit } from "@/components/marketing/MarketingRevealInit";
import { MarketingSubpageShell } from "@/components/marketing/MarketingSubpageShell";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/download",
    title: t("downloadTitle"),
    description: t("downloadDescription"),
  });
}

export default async function DownloadPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  return (
    <MarketingSubpageShell>
      <MarketingRevealInit />
      <div className="pt-6">
        <DownloadSection />
      </div>
    </MarketingSubpageShell>
  );
}
