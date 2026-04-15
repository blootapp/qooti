export function HomeJsonLd() {
  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "qooti",
    url: "https://bloot.app",
    description:
      "Visual inspiration library for creatives. Save images and videos from any website to your local library with one click.",
    applicationCategory: "DesignApplication",
    operatingSystem: "Windows, macOS",
    offers: [
      { "@type": "Offer", name: "1 Month", price: "49000", priceCurrency: "UZS" },
      { "@type": "Offer", name: "6 Months", price: "199000", priceCurrency: "UZS" },
      { "@type": "Offer", name: "1 Year", price: "299000", priceCurrency: "UZS" },
    ],
    publisher: {
      "@type": "Organization",
      name: "bloot",
      url: "https://bloot.app",
    },
  };

  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "bloot",
    url: "https://bloot.app",
    logo: "https://bloot.app/assets/bloot.png",
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      url: "https://t.me/blootsupport",
    },
    sameAs: ["https://t.me/blootapp"],
  };

  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    url: "https://bloot.app",
    name: "bloot",
    potentialAction: {
      "@type": "SearchAction",
      target: "https://bloot.app/help?q={search_term_string}",
      "query-input": "required name=search_term_string",
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(software) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(website) }} />
    </>
  );
}
