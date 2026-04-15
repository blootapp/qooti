import { setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { routing } from "@/i18n/routing";

export default async function DownloadThanksPage({
  params,
}: {
  params: Promise<{ locale: string; os: string }>;
}) {
  const { locale, os } = await params;
  if (!routing.locales.includes(locale as "uz" | "en")) notFound();
  setRequestLocale(locale);

  const platform = os === "macos" ? "mac" : os === "windows" ? "win" : null;
  if (!platform) notFound();
  redirect(`/download/thank-you?platform=${platform}`);
}
