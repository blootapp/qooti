import { getTranslations } from "next-intl/server";
import { ForgotPasswordForm } from "@/components/ForgotPasswordForm";
import { buildNoIndexMetadata } from "@/lib/seo/metadata";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildNoIndexMetadata({
    title: t("forgotPasswordTitle"),
    description: t("forgotPasswordDescription"),
  });
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
