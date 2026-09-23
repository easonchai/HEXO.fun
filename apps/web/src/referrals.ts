/**
 * Pure Referrals-screen logic (referral-page ticket 01): the hero card's
 * code-field view-model and the `?ref=CODE` share link. Kept out of
 * Referrals.tsx so the layout can change without touching this, mirroring
 * how ticket 09 split access.ts / useAccessGate.ts / AccessGate.tsx.
 *
 * The band/bonus/team helpers this file used to hold (hexo-referrals ticket
 * 11) are gone with the placeholder screen they served; tickets 03-05 bring
 * their own view-model additions back once the API grows `band`, `nextBand`
 * and the paginated `referrals` shape (spec.md "Referrals API response").
 */
import type { ReferralsDto } from "./api.js";

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
