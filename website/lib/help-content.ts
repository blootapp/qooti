import path from "node:path";
import fs from "node:fs";

export const HELP_SLUGS = ["install-macos", "install-windows", "chrome-extension", "purchase-plan"] as const;
export type HelpSlug = (typeof HELP_SLUGS)[number];

export function isHelpSlug(s: string): s is HelpSlug {
  return (HELP_SLUGS as readonly string[]).includes(s);
}

export function readHelpArticle(locale: string, slug: HelpSlug): string {
  const filePath = path.join(process.cwd(), "content", "help", locale, `${slug}.md`);
  return fs.readFileSync(filePath, "utf8");
}
