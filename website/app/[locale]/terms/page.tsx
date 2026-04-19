import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LegalMarkdownBody } from "@/components/legal/LegalMarkdownBody";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";
import termsEn from "@/files/qooti-terms-en.md";
import termsUz from "@/files/qooti-terms-uz.md";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildPublicPageMetadata({
    locale,
    pathname: "/terms",
    title: t("termsTitle"),
    description: t("termsDescription"),
  });
}

export default async function TermsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  const source = locale === "en" ? termsEn : termsUz;

  return (
    <LegalPageShell>
      <article className="legal-md">
        <LegalMarkdownBody source={source} />
      </article>
    </LegalPageShell>
  );
}
