"use client";

import { useEffect, useState } from "react";
import { PricingSection, type PlanUserMini } from "@/components/marketing/PricingSection";

type AuthMeResponse = { user?: { username?: string; publicId?: string; blootUserId?: string } };

export function PricingPageView() {
  const [planUser, setPlanUser] = useState<PlanUserMini | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => r.json())
      .then((data: AuthMeResponse) => {
        const user = data?.user;
        if (user?.username) {
          setPlanUser({ username: user.username, publicId: user.publicId || user.blootUserId || null });
        } else {
          setPlanUser(null);
        }
      })
      .catch(() => {});
  }, []);

  return <PricingSection planUser={planUser} />;
}
