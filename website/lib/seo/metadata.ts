import type { Metadata } from "next";
import { absoluteUrl, getSiteUrl, ogLocaleForUi } from "@/lib/seo/site";

const OG_IMAGE_PATH = "/assets/og-image.png";

function ogImageAbsolute(): string {
  return `${getSiteUrl()}${OG_IMAGE_PATH}`;
}

export function buildPublicPageMetadata(input: {
  locale: string;
  /** Path without locale prefix, e.g. `/` or `/download`. */
  pathname: string;
  title: string;
  description: string;
}): Metadata {
  const canonical = absoluteUrl(input.locale, input.pathname);
  const uz = absoluteUrl("uz", input.pathname);
  const en = absoluteUrl("en", input.pathname);
  const { primary, alternate } = ogLocaleForUi(input.locale);

  return {
    title: input.title,
    description: input.description,
    robots: { index: true, follow: true },
    alternates: {
      canonical,
      languages: {
        uz,
        en,
        "x-default": uz,
      },
    },
    openGraph: {
      type: "website",
      url: canonical,
      title: input.title,
      description: input.description,
      siteName: "bloot",
      locale: primary,
      alternateLocale: [alternate],
      images: [
        {
          url: ogImageAbsolute(),
          width: 1200,
          height: 630,
          alt: input.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [ogImageAbsolute()],
    },
  };
}

export function buildNoIndexMetadata(input?: { title?: string; description?: string }): Metadata {
  const base: Metadata = {
    robots: { index: false, follow: false },
  };
  if (input?.title) base.title = input.title;
  if (input?.description) base.description = input.description;
  return base;
}

/** Public-style OG/Twitter tags but blocked from indexing (e.g. thank-you). */
export function buildNoIndexSocialMetadata(input: {
  locale: string;
  pathname: string;
  title: string;
  description: string;
}): Metadata {
  const social = buildPublicPageMetadata(input);
  return {
    ...social,
    robots: { index: false, follow: false },
  };
}

/** Non-localized URL (e.g. `/download/thank-you`): single canonical, no hreflang alternates. */
export function buildFixedNoIndexSocialMetadata(input: {
  path: string;
  title: string;
  description: string;
}): Metadata {
  const canonical = `${getSiteUrl()}${input.path.startsWith("/") ? input.path : `/${input.path}`}`;
  const { primary, alternate } = ogLocaleForUi("uz");

  return {
    title: input.title,
    description: input.description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: {
      type: "website",
      url: canonical,
      title: input.title,
      description: input.description,
      siteName: "bloot",
      locale: primary,
      alternateLocale: [alternate],
      images: [
        {
          url: ogImageAbsolute(),
          width: 1200,
          height: 630,
          alt: input.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [ogImageAbsolute()],
    },
  };
}

export function rootLayoutMetadata(): Metadata {
  return {
    metadataBase: new URL(getSiteUrl()),
    applicationName: "bloot",
  };
}
