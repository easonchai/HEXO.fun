/**
 * Pure invite-gate logic (docs/plan/hexo-referrals ticket 09): the message a
 * wallet signs to redeem a code, code normalization, the `?invite=CODE`
 * prefill, what the gate modal shows, and error copy. Kept out of
 * AccessGate.tsx so the designer can restyle the markup without touching any
 * of this.
 *
 * `normalizeInviteCode` and `accessMessage` mirror the backend exactly
 * (apps/backend/src/api/invite-code.ts): a signature built over a
 * differently-cased or unnormalized string fails verification with a 400.
 */
import type { AccessDto } from "./api.js";

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The exact bytes the wallet signs for `POST /access/redeem`. With a
 *  `referralCode` (referral-page ticket 02), it rides inside this same
 *  message so applying one costs no extra signature; omitted, the message is
 *  exactly what it was before ticket 02. */
export function accessMessage(wallet: string, code: string, referralCode?: string): string {
  return referralCode
    ? `HEXO access: ${wallet} ${code} ref:${referralCode}`
    : `HEXO access: ${wallet} ${code}`;
}

/** `?invite=CODE` from `location.search`; "" when absent. */
export function inviteCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get("invite")?.trim() ?? "";
}

/** What the gate overlay shows. "hidden" once access is confirmed allowed;
 *  "failed" when `GET /access` itself could not be reached (pre-mainnet
 *  review): the gate names the error and retries instead of sitting on
 *  "Checking…" with SUBMIT disabled and no way out. */
export type GateStatus = "hidden" | "connect" | "checking" | "failed" | "redeem";

/** `checkError` is the `fetchAccess` failure reason while no answer has
 *  landed; it only matters before `access` is known, since a later failed
 *  re-check never discards an answer already in hand. */
export function gateDecision(
  connected: boolean,
  access: AccessDto | null,
  checkError: string | null = null,
): GateStatus {
  if (!connected) return "connect";
  if (access === null) return checkError === null ? "checking" : "failed";
  return access.allowed ? "hidden" : "redeem";
}

/** The gate's line for a failed access check; the Retry button sits next
 *  to it, and the automatic re-check runs regardless. */
export function checkErrorMessage(reason: string): string {
  return `Could not check this wallet's access (${reason || "server unreachable"}). Retrying…`;
}

/** Automatic re-check backoff after the n-th consecutive `fetchAccess`
 *  failure (0-based): 2s, 4s, 8s, then 15s for good, so a backend that is
 *  merely restarting clears the gate within seconds while one that is down
 *  is not hammered. */
export function accessRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempt), 15_000);
}

/**
 * Maps a `redeemAccess` failure to one of the four error lines the ticket
 * asks for. Both 409s share a status code, so that case falls back to the
 * backend's message text (see access.controller.ts for the exact strings).
 */
export function classifyRedeemError(status: number | null, reason: string): string {
  if (status === 400) return "Signature refused. Try again.";
  if (status === 404) return "Invite code not found.";
  if (status === 409)
    return /no uses left/i.test(reason)
      ? "This invite code has no uses left."
      : "This wallet already redeemed an invite code.";
  return reason || "Could not reach the server. Try again.";
}
