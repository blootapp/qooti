"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Scrolls to `#id` when the URL contains a hash (e.g. /dashboard/billing#plans). */
export function ScrollToHash() {
  const pathname = usePathname();

  useEffect(() => {
    const run = () => {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      if (!hash || hash.length < 2) return;
      const id = hash.slice(1);
      const el = document.getElementById(id);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    run();
    window.addEventListener("hashchange", run);
    return () => window.removeEventListener("hashchange", run);
  }, [pathname]);

  return null;
}
