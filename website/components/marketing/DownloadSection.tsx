"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import "@/styles/marketing.css";

export function DownloadSection() {
  const t = useTranslations("Home");
  const tNav = useTranslations("Nav");

  return (
    <section className="download-section" id="download">
      <div className="download-section__inner">
        <div className="download-section__content reveal">
          <div className="screenshot-wrap">
            <div className="screenshot-shell">
              <img
                src="/assets/app.png"
                alt={t("downloadScreenshotAlt")}
                className="app-screenshot"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                  if (fallback) fallback.style.display = "flex";
                }}
              />
              <div className="app-screenshot-fallback" style={{ display: "none" }}>
                Screenshot
              </div>
            </div>
          </div>

          <p className="download-section-label">{t("dlEyebrow")}</p>
          <h2 className="download-headline">
            {t("dlTitle")} {t("dlTitle2")}
          </h2>
          <p className="download-sub">{t("dlSub")}</p>

          <div className="download-buttons">
            <a href="/download/thank-you?platform=mac" className="download-dl-btn">
              <span className="download-dl-btn__icon" aria-hidden="true">
                <img src="/assets/apple-fill.svg" alt="" width={18} height={18} className="download-dl-btn__svg" />
              </span>
              <span className="download-dl-btn__text">
                <span className="download-dl-btn__label">{tNav("download")}</span>
                <span className="download-dl-btn__platform">macOS</span>
              </span>
            </a>
            <a href="/download/thank-you?platform=win" className="download-dl-btn">
              <span className="download-dl-btn__icon" aria-hidden="true">
                <img src="/assets/windows-fill.svg" alt="" width={16} height={16} className="download-dl-btn__svg" />
              </span>
              <span className="download-dl-btn__text">
                <span className="download-dl-btn__label">{tNav("download")}</span>
                <span className="download-dl-btn__platform">Windows</span>
              </span>
            </a>
          </div>

          <Link href="/help/chrome-extension" className="extension-link">
            <span className="extension-link__chrome" aria-hidden="true" />
            {t("chromeExt")}
          </Link>
        </div>
      </div>
    </section>
  );
}
