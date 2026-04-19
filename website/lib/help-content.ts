import enChromeExtension from "../content/help/en/chrome-extension.md";
import enInstallMacos from "../content/help/en/install-macos.md";
import enInstallWindows from "../content/help/en/install-windows.md";
import enPurchasePlan from "../content/help/en/purchase-plan.md";
import uzChromeExtension from "../content/help/uz/chrome-extension.md";
import uzInstallMacos from "../content/help/uz/install-macos.md";
import uzInstallWindows from "../content/help/uz/install-windows.md";
import uzPurchasePlan from "../content/help/uz/purchase-plan.md";

export const HELP_SLUGS = ["install-macos", "install-windows", "chrome-extension", "purchase-plan"] as const;
export type HelpSlug = (typeof HELP_SLUGS)[number];

const HELP: Record<"en" | "uz", Record<HelpSlug, string>> = {
  en: {
    "install-macos": enInstallMacos,
    "install-windows": enInstallWindows,
    "chrome-extension": enChromeExtension,
    "purchase-plan": enPurchasePlan,
  },
  uz: {
    "install-macos": uzInstallMacos,
    "install-windows": uzInstallWindows,
    "chrome-extension": uzChromeExtension,
    "purchase-plan": uzPurchasePlan,
  },
};

export function isHelpSlug(s: string): s is HelpSlug {
  return (HELP_SLUGS as readonly string[]).includes(s);
}

export function readHelpArticle(locale: string, slug: HelpSlug): string {
  const loc = locale === "uz" ? "uz" : "en";
  return HELP[loc][slug];
}
