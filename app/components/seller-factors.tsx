import type { SellerFactors } from "@/lib/seller-factors";

const STAGE: Record<SellerFactors["stage"], string> = { new_onboarding: "New onboarding", renewal: "Renewal", upsell: "Upsell", servicing: "Servicing", prospect: "Prospect" };
const URGENCY: Record<SellerFactors["urgency"]["level"], string> = { high: "Retry sooner", normal: "Normal pace", give_space: "Give space" };

/** Business factors that shape the retry: segment, lifecycle stage, last successful meeting and urgency. */
export default function SellerFactorChips({ factors, title = "Seller factors" }: { factors: SellerFactors | null | undefined; title?: string }) {
  if (!factors) return null;
  const met = factors.last_successful_meeting;
  return <section className="factor-panel" aria-label={title}>
    <span className="eyebrow">{title}</span>
    <div className="factor-chips">
      {factors.stages.map(s => <span key={s} className={`factor-chip stage-${s}`}>{STAGE[s]}</span>)}
      {factors.segment.vertical && <span className="factor-chip">Segment: {factors.segment.vertical}</span>}
      {factors.segment.products.length > 0 && <span className="factor-chip">Sells: {factors.segment.products.join(", ")}</span>}
      {factors.segment.service && <span className="factor-chip">{factors.segment.service}{factors.segment.plan ? ` · ${factors.segment.plan}` : ""}</span>}
      {factors.service_days !== null && <span className="factor-chip">{factors.service_days} days into service</span>}
      <span className="factor-chip">{met ? `Last successful meeting ${met.days_ago === 0 ? "today" : `${met.days_ago} days ago`}${met.purpose ? ` · ${met.purpose}` : ""}` : "No successful meeting yet"}</span>
      {factors.risk.high_churn && <span className="factor-chip risk">High churn risk</span>}
      {factors.risk.payment_issue && <span className="factor-chip risk">{factors.risk.payment_issue}</span>}
      {factors.risk.complaints_7d > 0 && <span className="factor-chip risk">{factors.risk.complaints_7d} complaint{factors.risk.complaints_7d === 1 ? "" : "s"} this week</span>}
    </div>
    <p className={`factor-urgency urgency-${factors.urgency.level}`}><b>{URGENCY[factors.urgency.level]}</b>{factors.urgency.reasons.length > 0 ? `: ${factors.urgency.reasons.join("; ")}` : ": no deadline or risk signal, so the strongest slot is preferred"}</p>
  </section>;
}
