import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/components/AuthForm";
import { buildNoIndexMetadata } from "@/lib/seo/metadata";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "Seo" });
  return buildNoIndexMetadata({
    title: t("loginTitle"),
    description: t("loginDescription"),
  });
}

export default function LoginPage() {
  return <AuthForm purpose="login" />;
}
