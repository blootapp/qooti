"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toYouTubeEmbedUrl } from "@/lib/youtube-embed";

const COLORS = ["#4eabfb", "#32d74b", "#ff9f0a", "#bf5af2", "#ff6b6b", "#f0f0ee"];
const RELEASES_PAGE = "https://github.com/blootapp/qooti-releases/releases";

type Props = {
  videoMacUrl: string | null;
  videoWinUrl: string | null;
};

function getPlatform(searchParams: ReturnType<typeof useSearchParams>): "mac" | "win" {
  const platform = searchParams.get("platform");
  if (platform === "mac") return "mac";
  if (platform === "win") return "win";
  if (typeof navigator !== "undefined" && navigator.userAgent.includes("Mac")) return "mac";
  return "win";
}

export function QootiThankYouClient({ videoMacUrl, videoWinUrl }: Props) {
  const searchParams = useSearchParams();
  const platform = useMemo(() => getPlatform(searchParams), [searchParams]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRetryLoading, setIsRetryLoading] = useState(false);

  const rawVideo = platform === "mac" ? videoMacUrl : videoWinUrl;
  const embed = toYouTubeEmbedUrl(rawVideo ?? undefined) ?? "https://www.youtube.com/embed/VIDEO_ID_HERE";

  async function getDownloadUrl() {
    try {
      const res = await fetch(`/api/download/latest?platform=${platform}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (res.ok && data.url) return data.url;
    } catch {}
    return RELEASES_PAGE;
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      getDownloadUrl().then((url) => {
        const link = document.createElement("a");
        link.href = url;
        link.download = "";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [platform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    resize();

    const pieces = Array.from({ length: 120 }, () => ({
      x: Math.random() * width,
      y: -30 - Math.random() * height * 0.6,
      w: 6 + Math.random() * 8,
      h: 3 + Math.random() * 4,
      vx: (Math.random() - 0.5) * 1.2,
      vy: 2.2 + Math.random() * 3.8,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.12,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      active: true,
    }));

    const fadeAlpha = (y: number) => {
      const fadeStart = height * 0.7;
      if (y < fadeStart) return 1;
      const t = (y - fadeStart) / (height - fadeStart + 0.001);
      return Math.max(0, 1 - t);
    };

    const tick = () => {
      ctx.clearRect(0, 0, width, height);
      let activeCount = 0;

      for (const p of pieces) {
        if (!p.active) continue;

        p.vx += (Math.random() - 0.5) * 0.08;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;

        const alpha = fadeAlpha(p.y);
        if (p.y > height + 40 || alpha <= 0.008) {
          p.active = false;
          continue;
        }
        activeCount++;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      if (activeCount > 0) {
        requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    };

    requestAnimationFrame(tick);
  }, []);

  async function onRetry() {
    setIsRetryLoading(true);
    const url = await getDownloadUrl();
    window.location.href = url;
  }

  return (
    <>
      <canvas id="confetti-canvas" ref={canvasRef} aria-hidden="true" />

      <main className="thank-you-page">
        <section className="hero" aria-labelledby="thanks-title">
          <div className="logo-mark">
            <img src="/assets/bloot.png" alt="bloot" className="logo-mark-img" width={120} height={28} />
          </div>
          <h1 id="thanks-title">Yuklab olganingiz uchun rahmat!</h1>
          <p className="hero-sub">qooti yuklanmoqda. O&apos;rnatish uchun quyidagi qo&apos;llanmani ko&apos;rib chiqing.</p>
        </section>

        <section className="video-section" aria-labelledby="video-label">
          <p id="video-label" className="section-label">
            O&apos;RNATISH BO&apos;YICHA VIDEO QO&apos;LLANMA
          </p>
          <div className="video-card">
            <div style={{ position: "relative", paddingBottom: "56.25%", height: 0 }}>
              <iframe
                src={embed}
                title="qooti o'rnatish qo'llanmasi"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", border: "none" }}
              />
            </div>
          </div>
          <div className="video-retry-wrap">
            <button type="button" id="retry-btn" onClick={onRetry} disabled={isRetryLoading}>
              <img
                src="/assets/reset-right-line.svg"
                alt=""
                width={16}
                height={16}
                className="retry-icon"
                aria-hidden
              />
              {isRetryLoading ? "Yuklanmoqda..." : "Yuklanmadimi? Bu yerga bosing"}
            </button>
          </div>
        </section>

        <div className="divider" role="separator" />

        <section aria-labelledby="tutorials-label">
          <p id="tutorials-label" className="section-label">
            QO&apos;LLANMALAR
          </p>
          <div className="tutorial-list">
            <TutorialRow
              title="macOS'ga o'rnatish"
              desc="DMG faylni ochib, qooti'ni Applications papkasiga torting"
              href="#"
            />
            <TutorialRow
              title="Windows'ga o'rnatish"
              desc="EXE faylni ishga tushiring va ko'rsatmalarga amal qiling"
              href="#"
            />
            <TutorialRow
              title="Chrome extension"
              desc="Kengaytmani o'rnatib, qooti bilan bog'lang"
              href="#"
            />
            <TutorialRow
              title="Birinchi marta ishlatish"
              desc="Ilhom saqlashni boshlash uchun qo'llanma"
              href="#"
            />
            <TutorialRow
              title="Kolleksiyalar bilan ishlash"
              desc="Ilhomlaringizni tartibga solish va topish"
              href="#"
            />
            <TutorialRow
              title="Yordam kerakmi?"
              desc="@blootsupport orqali biz bilan bog'laning"
              href="https://t.me/blootsupport"
              external
            />
          </div>
        </section>
      </main>

      <style jsx global>{`
        :root {
          --bg: #0a0a0a;
          --surface: #111111;
          --surface2: #181818;
          --border: rgba(255,255,255,0.07);
          --border-hover: rgba(255,255,255,0.13);
          --accent: #4eabfb;
          --accent-soft: rgba(78,171,251,0.08);
          --accent-border: rgba(78,171,251,0.18);
          --white: #f0f0ee;
          --muted: rgba(240,240,238,0.38);
          --muted2: rgba(240,240,238,0.16);
          --font: 'Geist', -apple-system, sans-serif;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }

        body {
          background: var(--bg);
          font-family: var(--font);
          -webkit-font-smoothing: antialiased;
          background-image:
            radial-gradient(ellipse at 50% -20%, rgba(78,171,251,0.12), transparent 55%),
            radial-gradient(ellipse at 95% 35%, rgba(78,171,251,0.06), transparent 55%),
            radial-gradient(ellipse at 5% 75%, rgba(78,171,251,0.04), transparent 52%);
        }

        #confetti-canvas {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 999;
        }

        .thank-you-page {
          max-width: 720px;
          margin: 0 auto;
          padding: 72px 24px 96px;
          color: var(--white);
        }

        .hero {
          text-align: center;
          margin-bottom: 40px;
        }

        .logo-mark {
          margin: 0 auto 24px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .logo-mark-img {
          height: 26px;
          width: auto;
          max-width: min(200px, 85vw);
          object-fit: contain;
          display: block;
          mix-blend-mode: screen;
        }

        #thanks-title {
          font-size: 38px;
          font-weight: 700;
          letter-spacing: -0.04em;
          color: var(--white);
          line-height: 1.1;
          margin-bottom: 12px;
        }

        .hero-sub {
          font-size: 15px;
          color: var(--muted);
          font-weight: 300;
          line-height: 1.65;
          max-width: 400px;
          margin: 0 auto;
        }

        .video-retry-wrap {
          margin-top: 18px;
          text-align: center;
        }

        #retry-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          font-size: 12.5px;
          color: var(--muted2);
          border: 0;
          border-bottom: 0.5px solid var(--muted2);
          background: transparent;
          padding: 4px 2px 4px;
          cursor: pointer;
          font-family: var(--font);
          transition: color 150ms ease, border-color 150ms ease;
        }

        #retry-btn:hover {
          color: var(--muted);
          border-bottom-color: var(--muted);
        }
        #retry-btn:disabled {
          opacity: 0.72;
          cursor: progress;
        }

        .retry-icon {
          flex-shrink: 0;
          opacity: 0.85;
          filter: invert(1) brightness(0.65);
        }

        .video-section {
          margin-bottom: 4px;
        }

        .section-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted2);
          margin-bottom: 14px;
        }

        .video-card {
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          border: 0.5px solid var(--border);
          border-radius: 16px;
          overflow: hidden;
          margin-bottom: 0;
          box-shadow:
            0 0 0 1px rgba(255,255,255,0.02) inset,
            0 22px 54px rgba(0,0,0,0.38);
        }

        .divider {
          height: 0.5px;
          background: var(--border);
          margin: 36px 0;
        }

        .tutorial-list {
          display: flex;
          flex-direction: column;
          border-top: 0.5px solid var(--border);
        }

        .tutorial-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 14px 4px;
          border-bottom: 0.5px solid var(--border);
          text-decoration: none;
          color: inherit;
          transition: background 120ms ease;
        }

        .tutorial-row:hover {
          background: rgba(255,255,255,0.03);
        }

        .tutorial-row-text {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
          text-align: left;
        }

        .tutorial-title {
          display: block;
          font-size: 13px;
          font-weight: 500;
          color: var(--white);
          letter-spacing: -0.01em;
          line-height: 1.25;
        }

        .tutorial-desc {
          display: block;
          font-size: 12px;
          color: var(--muted);
          font-weight: 300;
          line-height: 1.45;
        }

        .tutorial-chevron {
          flex-shrink: 0;
          color: var(--muted2);
          opacity: 0.7;
        }

        @media (max-width: 600px) {
          .thank-you-page {
            padding: 48px 20px 64px;
          }
          #thanks-title {
            font-size: 28px;
          }
        }
      `}</style>
    </>
  );
}

function TutorialRow({
  title,
  desc,
  href,
  external,
}: {
  title: string;
  desc: string;
  href: string;
  external?: boolean;
}) {
  return (
    <a className="tutorial-row" href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      <span className="tutorial-row-text">
        <span className="tutorial-title">{title}</span>
        <span className="tutorial-desc">{desc}</span>
      </span>
      <svg className="tutorial-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
