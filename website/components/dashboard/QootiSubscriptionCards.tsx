import { buildTelegramUrl } from "@/lib/qooti-subscription";
import type { QootiPackDisplay } from "@/lib/qooti-subscription-ui";
import "@/styles/marketing.css";

type Props = {
  username: string;
  publicId: string;
  packs: QootiPackDisplay[];
  benefits: string[];
  sectionTitle: string;
  sectionSub: string;
  periodNote: string;
  taxNote: string;
  buyLabel: string;
  bestValueLabel: string;
};

export function QootiSubscriptionCards({
  username,
  publicId,
  packs,
  benefits,
  sectionTitle,
  sectionSub,
  periodNote,
  taxNote,
  buyLabel,
  bestValueLabel,
}: Props) {
  return (
    <section id="plans" className="section-spacing scroll-mt-28">
      <div className="mb-6">
        <h2 className="section-label">{sectionTitle}</h2>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-[var(--muted)]">{sectionSub}</p>
      </div>
      <div className="pricing-grid !mt-4 max-w-none">
        {packs.map((pkg) => {
          const href = buildTelegramUrl(username, publicId, pkg.packageLine);
          return (
            <div key={pkg.id} className={pkg.popular ? "plan featured" : "plan"}>
              {pkg.popular ? (
                <span className="plan-tag">{bestValueLabel}</span>
              ) : (
                <span className="plan-tag" aria-hidden />
              )}
              <p className="plan-name">{pkg.title}</p>
              <div className="plan-price !flex-none !text-[clamp(28px,3.2vw,40px)] !font-light !leading-none !tracking-tight">
                {pkg.priceLabel}
              </div>
              <p className="plan-note !mb-6">
                {pkg.subtitle}
                <br />
                <span className="text-[11px] text-[var(--muted2)]">
                  {periodNote} · {taxNote}
                </span>
              </p>
              <div className="plan-line" />
              <ul className="plan-features">
                {benefits.map((line) => (
                  <li key={line}>
                    <svg className="plan-check" width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M2.5 7l3 3 6-6"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {line}
                  </li>
                ))}
              </ul>
              <a href={href} target="_blank" rel="noopener noreferrer" className="plan-btn">
                {buyLabel}
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
