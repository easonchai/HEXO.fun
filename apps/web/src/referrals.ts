/**
 * Pure Referrals-screen logic (referral-page ticket 01): the hero card's
 * code-field view-model and the `?ref=CODE` share link. Kept out of
 * Referrals.tsx so the layout can change without touching this, mirroring
 * how ticket 09 split access.ts / useAccessGate.ts / AccessGate.tsx.
 *
 * The band/bonus/team helpers this file used to hold (hexo-referrals ticket
 * 11) are gone with the placeholder screen they served; ticket 03 brings the
 * band view-model back below, now over the API's `band`/`nextBand` shape.
 * Tickets 04-05 bring the rest back once the API grows the paginated
 * `referrals` shape (spec.md "Referrals API response").
 */
import type { ReferralBandDto, ReferralsDto } from "./api.js";

/** Hero card's code-field state (spec.md "Web page structure", user stories
 *  6-7): no wallet connected, connected but never deposited (no Referral
 *  code minted yet), or connected with a code to show and share. */
export type ReferralHeroState =
  | { kind: "disconnected" }
  | { kind: "no-code" }
  | { kind: "has-code"; code: string };

export function referralHeroState(
  owner: string | null | undefined,
  data: ReferralsDto | null,
): ReferralHeroState {
  if (!owner) return { kind: "disconnected" };
  if (!data?.referralCode) return { kind: "no-code" };
  return { kind: "has-code", code: data.referralCode };
}

/** spec.md Copy: "COPY copies `${origin}/?ref=CODE`", using the app's own origin. */
export function shareLink(origin: string, code: string): string {
  return `${origin}/?ref=${code}`;
}

/** `?ref=CODE` from `location.search`; "" when absent. Mirrors
 *  `inviteCodeFromSearch` (access.ts ticket 09). */
export function refCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get("ref")?.trim() ?? "";
}

/** The exact bytes `POST /referrals/apply` must be signed over (ticket 02),
 *  mirroring the backend's `applyReferralMessage`
 *  (apps/backend/src/api/invite-code.ts). Distinct from `accessMessage`, so a
 *  redeem signature can't be replayed here. */
export function applyReferralMessage(wallet: string, code: string): string {
  return `HEXO apply referral: ${wallet} ${code}`;
}

/** Tier 0: no qualified referrals yet, matching the backend's `bandForCount(0)`. */
const ZERO_BAND: ReferralBandDto = { tier: 0, rateBps: 0, minCount: 0, maxCount: 0 };
/** Tier 1's range (spec.md "Bonus Rate tooltip": "1–2 friends: 2%"), the
 *  implicit next band before the first poll lands — matching what
 *  `bandForCount(0)` actually returns, so this looks the same as a freshly
 *  connected wallet with 0 qualified referrals. */
const FIRST_BAND: ReferralBandDto = { tier: 1, rateBps: 200, minCount: 1, maxCount: 2 };

/** Bonus Rate card's view-model (referral-page ticket 03, Figma `230:16970`). */
export type BonusRateView =
  | { kind: "disconnected" }
  | {
      kind: "ready";
      /** "3%", "0%" at tier 0. */
      ratePercent: string;
      /** "TIER 2 (3-5 QUALIFIED REFERRALS)", "TIER 4 (11+ QUALIFIED REFERRALS)"
       *  at the top tier; null at tier 0, which has no range of its own. */
      tierLabel: string | null;
      /** qualifiedCount / nextBand.minCount; 1 (full) at the top tier. */
      progressFraction: number;
      /** "N qualified referrals · M more to unlock X%"; "N qualified
       *  referrals · Max tier" at the top tier; "1-2 qualified referrals
       *  unlock 2%" at tier 0 (spec.md user story 13). */
      progressCopy: string;
    };

const percent = (rateBps: number): string => `${rateBps / 100}%`;

const tierLabel = (band: ReferralBandDto): string =>
  `TIER ${band.tier} (${band.minCount}${band.maxCount === null ? "+" : `-${band.maxCount}`} QUALIFIED REFERRALS)`;

export function bonusRateView(
  owner: string | null | undefined,
  data: ReferralsDto | null,
): BonusRateView {
  if (!owner) return { kind: "disconnected" };

  const { qualifiedCount, band, nextBand } = data ?? {
    qualifiedCount: 0,
    band: ZERO_BAND,
    nextBand: FIRST_BAND,
  };
  const ratePercent = percent(band.rateBps);

  if (nextBand === null) {
    return {
      kind: "ready",
      ratePercent,
      tierLabel: tierLabel(band),
      progressFraction: 1,
      progressCopy: `${qualifiedCount} qualified referrals · Max tier`,
    };
  }

  const progressCopy =
    band.tier === 0
      ? `${nextBand.minCount}-${nextBand.maxCount} qualified referrals unlock ${percent(nextBand.rateBps)}`
      : `${qualifiedCount} qualified referrals · ${nextBand.minCount - qualifiedCount} more to unlock ${percent(nextBand.rateBps)}`;

  return {
    kind: "ready",
    ratePercent,
    tierLabel: band.tier === 0 ? null : tierLabel(band),
    progressFraction: qualifiedCount / nextBand.minCount,
    progressCopy,
  };
}
