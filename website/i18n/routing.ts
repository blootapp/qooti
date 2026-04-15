import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["uz", "en"],
  defaultLocale: "uz",
  localePrefix: "as-needed",
});
