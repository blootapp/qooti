import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LegalMarkdownBody } from "@/components/legal/LegalMarkdownBody";
import { HelpArticleShell } from "@/components/help/HelpArticleShell";
import { isHelpSlug, readHelpArticle } from "@/lib/help-content";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

const TITLE_KEY = {
  "install-macos": "installMac",
  "install-windows": "installWin",
  "chrome-extension": "chrome",
  "purchase-plan": "purchase",
} as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isHelpSlug(slug)) {
    const t = await getTranslations({ locale, namespace: "Seo" });
    return buildPublicPageMetadata({
      locale,
      pathname: "/help",
      title: t("helpTitle"),
      description: t("helpDescription"),
    });
  }
  const t = await getTranslations({ locale, namespace: "Help" });
  const k = TITLE_KEY[slug];
  const title = `${t(k)} — bloot`;
  let description = `${t(k)}. ${t("hubSub")}`;
  if (description.length > 160) description = `${description.slice(0, 157)}…`;
  return buildPublicPageMetadata({
    locale,
    pathname: `/help/${slug}`,
    title,
    description,
  });
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);
  if (!isHelpSlug(slug)) notFound();

  const source = readHelpArticle(locale, slug);

  return (
    <HelpArticleShell>
      <article className="legal-md">
        <LegalMarkdownBody source={source} />
      </article>
    </HelpArticleShell>
  );
}
