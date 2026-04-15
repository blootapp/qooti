"use client";

import { useEffect } from "react";
import { useRouter } from "@/i18n/navigation";

export function RedirectIfLoggedIn() {
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (data?.user) {
          router.replace("/dashboard");
        }
      })
      .catch(() => {});
  }, [router]);

  return null;
}
