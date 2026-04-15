import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LandingView } from "@/components/marketing/LandingView";
import { HomeJsonLd } from "@/components/seo/HomeJsonLd";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/",
    title: t("homeTitle"),
    description: t("homeDescription"),
  });
}

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  return (
    <>
      <HomeJsonLd />
      <LandingView />
    </>
  );
}
