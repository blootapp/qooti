import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LegalMarkdownBody } from "@/components/legal/LegalMarkdownBody";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";
import privacyEn from "@/files/privacy-policy-en.md";
import privacyUz from "@/files/privacy-policy-uz.md";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/privacy",
    title: t("privacyTitle"),
    description: t("privacyDescription"),
  });
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  const source = locale === "en" ? privacyEn : privacyUz;

  return (
    <LegalPageShell>
      <article className="legal-md">
        <LegalMarkdownBody source={source} />
      </article>
    </LegalPageShell>
  );
}
