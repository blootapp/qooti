"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";

/** Legacy URL: sends users to Billing → qooti packages. */
export default function QootiLicenseRedirectPage() {
  const router = useRouter();
  const t = useTranslations("DashboardBilling");

  useEffect(() => {
    router.replace("/dashboard/billing#plans");
  }, [router]);

  return (
    <div className="bg-bg text-muted flex min-h-[50vh] flex-col items-center justify-center gap-2 px-4">
      <p className="text-sm">{t("redirectingPlans")}</p>
    </div>
  );
}
