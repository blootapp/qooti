"use client";

import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";

export function PlanCta({ telegramUrl, children }: { telegramUrl: string | null; children: ReactNode }) {
  if (telegramUrl) {
    return (
      <a href={telegramUrl} className="plan-btn" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href="/signup" className="plan-btn">
      {children}
    </Link>
  );
}
