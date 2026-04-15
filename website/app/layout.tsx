import type { Metadata, Viewport } from "next";
import { rootLayoutMetadata } from "@/lib/seo/metadata";
import "./globals.css";

export const metadata: Metadata = {
  ...rootLayoutMetadata(),
  title: "bloot",
  description: "Visual inspiration library for creatives. Save images and videos from any website with qooti by bloot.",
  manifest: "/manifest.json",
  icons: {
    icon: [{ url: "/assets/logo.png", type: "image/png" }],
    apple: "/assets/logo.png",
  },
  other: {
    "format-detection": "telephone=no",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="uz" suppressHydrationWarning>
      <head>
        <meta httpEquiv="x-ua-compatible" content="IE=edge" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@200;300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
