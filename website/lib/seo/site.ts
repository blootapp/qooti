import { routing } from "@/i18n/routing";

export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "https://bloot.app";
  return raw.replace(/\/$/, "");
}

/** Path without locale prefix, e.g. `/`, `/download`, `/help`. */
export function absoluteUrl(locale: string, pathname: string): string {
  const base = getSiteUrl();
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (locale === routing.defaultLocale) {
    return path === "/" ? `${base}/` : `${base}${path}`;
  }
  return path === "/" ? `${base}/en` : `${base}/en${path}`;
}

export function ogLocaleForUi(locale: string): { primary: string; alternate: string } {
  if (locale === "en") return { primary: "en_US", alternate: "uz_UZ" };
  return { primary: "uz_UZ", alternate: "en_US" };
}
