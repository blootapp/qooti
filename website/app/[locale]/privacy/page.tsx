import fs from "node:fs";
import path from "node:path";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { LegalMarkdownBody } from "@/components/legal/LegalMarkdownBody";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import { buildPublicPageMetadata } from "@/lib/seo/metadata";
import { routing } from "@/i18n/routing";

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

  const file = locale === "en" ? "privacy-policy-en.md" : "privacy-policy-uz.md";
  const filePath = path.join(process.cwd(), "files", file);
  const source = fs.readFileSync(filePath, "utf8");

  return (
    <LegalPageShell>
      <article className="legal-md">
        <LegalMarkdownBody source={source} />
      </article>
    </LegalPageShell>
  );
}
