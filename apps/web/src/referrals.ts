/**
 * Pure referrals-screen logic (docs/plan/hexo-referrals ticket 11): the band
 * progress line, a referral row's status text, and the `?invite=CODE` share
 * link. Kept out of Referrals.tsx so the designer can restyle the markup
 * without touching any of this, mirroring how ticket 09 split access.ts /
 * useAccessGate.ts / AccessGate.tsx.
 */

/** Basis points as a whole-or-one-decimal percent: 200 -> "2%", 450 -> "4.5%". */
export function bpsToPercent(bps: number): string {
  return `${bps / 100}%`;
}

/**
 * spec.md Frontend: "band progress 'stated as a count' ('2 more to reach
 * 4%')". `rateBps`/`countToNextBand`/`nextRateBps` come straight off
 * `GET /referrals/:wallet` (backend's `bandForCount`, ticket 08's Follow-up).
 * At the top band (11+ qualified referrals) `countToNextBand` and
 * `nextRateBps` are both null: there is no next band to reach.
 */
export function bandProgressLabel(
  rateBps: number,
  countToNextBand: number | null,
  nextRateBps: number | null,
): string {
  if (countToNextBand === null || nextRateBps === null) {
    return `top band (${bpsToPercent(rateBps)})`;
  }
  const referral = countToNextBand === 1 ? "referral" : "referrals";
  return `${countToNextBand} more ${referral} to reach ${bpsToPercent(nextRateBps)}`;
}

/** One referral row's status text: qualified, a countdown, or not yet above
 *  the qualify threshold at all (CONTEXT.md "Qualified referral"). */
export function referralStatusLabel(qualified: boolean, daysToQualify: number | null): string {
  if (qualified) return "qualified";
  if (daysToQualify !== null) {
    return `${daysToQualify} day${daysToQualify === 1 ? "" : "s"} to qualify`;
  }
  return "not yet above $50";
}

/** spec.md Frontend: "share link `?invite=CODE`", using the app's own origin. */
export function shareLink(origin: string, code: string): string {
  return `${origin}/?invite=${code}`;
}
