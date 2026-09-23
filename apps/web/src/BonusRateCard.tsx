/**
 * Bonus Rate card (referral-page ticket 03, Figma `230:16970`): current
 * rate, tier and range, a progress bar, and how many more Qualified
 * referrals unlock the next rate. View-model lives in referrals.ts
 * (`bonusRateView`); this component only renders it, mirroring
 * Referrals.tsx's `ReferralHero`.
 */
import { InfoTip } from "./InfoTip.js";
import type { BonusRateView } from "./referrals.js";

/** spec.md Copy, "Bonus Rate tooltip" (Figma tooltip `230:17717`, text node
 *  under `204:15702`). The four tiers render as their own paragraphs: the
 *  source groups them tighter than the intro line, which InfoTip's
 *  one-`<p>`-per-paragraph layout doesn't distinguish — a minor spacing
 *  difference from Figma, not a content one. */
const BONUS_RATE_TIP = [
  "The percentage of daily tickets you earn based on your active friend’s deposits.",
  "• 1–2 friends: 2%",
  "• 3–5 friends: 3%",
  "• 6–10 friends: 4%",
  "• 11+ friends: 5%",
] as const;

export function BonusRateCard({ state }: { state: BonusRateView }) {
  const ready = state.kind === "ready" ? state : null;
  const fillPercent = (ready?.progressFraction ?? 0) * 100;

  return (
    <section className="bonus-rate-card" aria-label="Bonus Rate" data-testid="bonus-rate-card">
      <div className="bonus-rate-head">
        <h2 className="bonus-rate-title">Bonus Rate</h2>
        <InfoTip id="bonus-rate-tip" paragraphs={BONUS_RATE_TIP} />
      </div>

      <div className="bonus-rate-value">
        <span className="bonus-rate-percent" data-testid="bonus-rate-percent">
          {ready ? ready.ratePercent : "—"}
        </span>
        {ready?.tierLabel ? <span className="bonus-rate-tier">{ready.tierLabel}</span> : null}
      </div>

      <div className="bonus-rate-progress">
        <div className="bonus-rate-track">
          <div className="bonus-rate-fill" style={{ width: `${fillPercent}%` }} />
        </div>
        {ready ? <p className="bonus-rate-copy">{ready.progressCopy}</p> : null}
      </div>
    </section>
  );
}
