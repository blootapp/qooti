import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { QootiThankYouClient } from "@/components/download/QootiThankYouClient";
import { buildFixedNoIndexSocialMetadata } from "@/lib/seo/metadata";

export async function generateMetadata() {
  const t = await getTranslations({ locale: "uz", namespace: "Seo" });
  return buildFixedNoIndexSocialMetadata({
    path: "/download/thank-you",
    title: t("thankYouTitle"),
    description: t("thankYouDescription"),
  });
}

function ThankYouFallback() {
  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <div className="mx-auto max-w-2xl px-5 py-24 text-center text-[var(--muted)]">Yuklanmoqda…</div>
    </div>
  );
}

export default function DownloadThankYouPage() {
  const videoMacUrl = process.env.NEXT_PUBLIC_VIDEO_INSTALL_MAC ?? null;
  const videoWinUrl = process.env.NEXT_PUBLIC_VIDEO_INSTALL_WIN ?? null;

  return (
    <Suspense fallback={<ThankYouFallback />}>
      <QootiThankYouClient videoMacUrl={videoMacUrl} videoWinUrl={videoWinUrl} />
    </Suspense>
  );
}
