"use client";

import { useMemo, useState } from "react";

export function BlootIdPanel({ publicId }: { publicId: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const maskedId = useMemo(() => {
    if (!publicId) return "";
    if (publicId.length <= 8) return "••••••••";
    return `${publicId.slice(0, 3)}••••••••••${publicId.slice(-4)}`;
  }, [publicId]);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(publicId);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <section className="bloot-id-overview" aria-label="bloot id">
      <div className="bloot-id-overview-top">
        <p className="metric-label">bloot id</p>
        <div className="bloot-id-actions">
          <button
            type="button"
            className="bloot-id-btn"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
          <button
            type="button"
            className={`bloot-id-btn ${copyState === "copied" ? "copied" : ""}`}
            onClick={copyId}
          >
            {copyState === "copied" ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <code className={`bloot-id-overview-value ${revealed ? "revealed" : "masked"}`} title={publicId}>
        {revealed ? publicId : maskedId}
      </code>
    </section>
  );
}
