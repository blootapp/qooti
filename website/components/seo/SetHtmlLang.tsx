"use client";

import { useLocale } from "next-intl";
import { useEffect } from "react";

export function SetHtmlLang() {
  const locale = useLocale();

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "uz";
  }, [locale]);

  return null;
}
