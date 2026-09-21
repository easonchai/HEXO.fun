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

/** The exact bytes the wallet signs for `POST /access/redeem`. */
export function accessMessage(wallet: string, code: string): string {
  return `HEXO access: ${wallet} ${code}`;
}

/** `?invite=CODE` from `location.search`; "" when absent. */
export function inviteCodeFromSearch(search: string): string {
  return new URLSearchParams(search).get("invite")?.trim() ?? "";
}

/** What the gate overlay shows. "hidden" once access is confirmed allowed. */
export type GateStatus = "hidden" | "connect" | "checking" | "redeem";

export function gateDecision(
  connected: boolean,
  access: AccessDto | null,
): GateStatus {
  if (!connected) return "connect";
  if (access === null) return "checking";
  return access.allowed ? "hidden" : "redeem";
}

/**
 * Maps a `redeemAccess` failure to one of the four error lines the ticket
 * asks for. Both 409s share a status code, so that case falls back to the
 * backend's message text (see access.controller.ts for the exact strings).
 */
export function classifyRedeemError(status: number | null, reason: string): string {
  if (status === 400) return "signature refused";
  if (status === 404) return "unknown code";
  if (status === 409) return /no uses left/i.test(reason) ? "used up" : "already redeemed";
  return reason || "could not reach the server";
}
