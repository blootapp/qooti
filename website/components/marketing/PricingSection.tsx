"use client";

import { useTranslations } from "next-intl";
import { buildTelegramUrl, QOOTI_PACKAGES } from "@/lib/qooti-subscription";
import { PlanCta } from "@/components/marketing/PlanCta";
import "@/styles/marketing.css";

export type PlanUserMini = { username: string; publicId: string | null };

export function PricingSection({ planUser }: { planUser: PlanUserMini | null }) {
  const t = useTranslations("Home");

  return (
    <section className="pricing-section" id="pricing">
      <div className="wrap">
        <div className="pricing-head reveal">
          <p className="eyebrow">{t("pricingEyebrow")}</p>
          <h2 className="h2">{t("pricingTitle")}</h2>
          <p className="sub">{t("pricingSub")}</p>
        </div>
        <div className="pricing-grid reveal d1">
          <div className="plan">
            <span className="plan-tag" aria-hidden />
            <p className="plan-name">{t("planMonth")}</p>
            <div className="plan-price">
              49<span className="plan-suffix">,000 UZS</span>
            </div>
            <p className="plan-note">{t("subNote")}</p>
            <div className="plan-line" />
            <ul className="plan-features">
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featSaves")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featChrome")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featColl")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featSearch")}
              </li>
            </ul>
            <PlanCta
              telegramUrl={
                planUser ? buildTelegramUrl(planUser.username, planUser.publicId, QOOTI_PACKAGES[0].packageLine) : null
              }
            >
              {t("getStarted")}
            </PlanCta>
          </div>
          <div className="plan featured">
            <span className="plan-tag">{t("bestValue")}</span>
            <p className="plan-name">{t("planYear")}</p>
            <div className="plan-price">
              299<span className="plan-suffix">,000 UZS</span>
            </div>
            <p className="plan-note">{t("subNote49")}</p>
            <div className="plan-line" />
            <ul className="plan-features">
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featAll6")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featMobile")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featSupport")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featEarly")}
              </li>
            </ul>
            <PlanCta
              telegramUrl={
                planUser ? buildTelegramUrl(planUser.username, planUser.publicId, QOOTI_PACKAGES[1].packageLine) : null
              }
            >
              {t("getStarted")}
            </PlanCta>
          </div>
          <div className="plan">
            <span className="plan-tag" aria-hidden />
            <p className="plan-name">{t("plan6m")}</p>
            <div className="plan-price">
              199<span className="plan-suffix">,000 UZS</span>
            </div>
            <p className="plan-note">{t("subNote32")}</p>
            <div className="plan-line" />
            <ul className="plan-features">
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featAll1")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featMobile")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featSupport")}
              </li>
              <li>
                <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2.5 7l3 3 6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t("featEarly")}
              </li>
            </ul>
            <PlanCta
              telegramUrl={
                planUser ? buildTelegramUrl(planUser.username, planUser.publicId, QOOTI_PACKAGES[2].packageLine) : null
              }
            >
              {t("getStarted")}
            </PlanCta>
          </div>
        </div>
      </div>
    </section>
  );
}
