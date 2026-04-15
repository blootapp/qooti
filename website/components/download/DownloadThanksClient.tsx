"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { toYouTubeEmbedUrl } from "@/lib/youtube-embed";

const RELEASES = "https://github.com/blootapp/qooti-releases/releases";

type Props = {
  platform: "mac" | "win";
  videoUrl: string | null;
};

export function DownloadThanksClient({ platform, videoUrl }: Props) {
  const t = useTranslations("DownloadThanks");
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const platformLabel = platform === "mac" ? "macOS" : "Windows";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/download/latest?platform=${platform === "mac" ? "mac" : "win"}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as { url?: string; name?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.url) {
          setErr(data.error || "Error");
          return;
        }
        setUrl(data.url);
        setName(data.name || null);
        // Trigger a direct download in the current tab for better UX.
        window.location.assign(data.url);
      } catch {
        if (!cancelled) setErr("Error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const embedBase = videoUrl ? toYouTubeEmbedUrl(videoUrl) : null;
  const embed = embedBase
    ? `${embedBase}?autoplay=1&mute=1&controls=1&rel=0&modestbranding=1&playsinline=1`
    : null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_22%_18%,rgba(78,171,251,0.16),transparent_34%),radial-gradient(circle_at_78%_12%,rgba(240,240,238,0.07),transparent_28%),#0a0a0a]">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:py-20">
        <section className="rounded-2xl border border-[var(--border)] bg-[linear-gradient(175deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-6 shadow-[0_25px_70px_rgba(0,0,0,0.45)] backdrop-blur sm:p-8">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--accent)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            {platformLabel}
          </div>

          <h1 className="text-3xl font-semibold tracking-tight text-[var(--white)] sm:text-4xl">{t("title")}</h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--muted)]">{t("subtitle")}</p>

          {err ? (
            <p className="mt-6 rounded-lg border border-red-400/25 bg-red-500/8 px-4 py-3 text-sm text-red-300">
              {t("error")}
              <a
                href={RELEASES}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 font-medium text-red-200 underline underline-offset-2"
              >
                {t("releases")}
              </a>
            </p>
          ) : (
            <p className="mt-6 inline-flex rounded-full border border-[var(--border)] bg-[var(--surface2)] px-3 py-1 text-xs text-[var(--muted)]">
              {url ? name || t("downloadBtn") : t("preparing")}
            </p>
          )}

          {url && !err && (
            <a
              href={url}
              className="mt-7 inline-flex w-full items-center justify-center rounded-xl bg-[var(--white)] px-5 py-3 text-[13px] font-semibold text-black transition hover:-translate-y-0.5 hover:bg-[var(--accent)] sm:w-auto"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("downloadBtn")}
              {name ? ` (${name})` : ""}
            </a>
          )}

          <Link href="/" className="mt-7 inline-block text-sm font-medium text-[var(--accent)] hover:underline">
            {t("backHome")}
          </Link>
        </section>

        {embed && (
          <section className="rounded-2xl border border-[var(--border)] bg-[linear-gradient(170deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] p-4 shadow-[0_25px_70px_rgba(0,0,0,0.42)] sm:p-5">
            <h2 className="mb-3 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted2)]">
              {t("videoTitle")}
            </h2>
            <div className="relative aspect-video overflow-hidden rounded-xl border border-[var(--border)] bg-black">
              <iframe
                title="Install tutorial"
                src={embed}
                className="absolute inset-0 h-full w-full"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
