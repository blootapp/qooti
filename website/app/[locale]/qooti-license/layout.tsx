import { buildNoIndexMetadata } from "@/lib/seo/metadata";

export async function generateMetadata() {
  return buildNoIndexMetadata();
}

export default function QootiLicenseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
