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
 *  "loading" while the wallet layer is still restoring a session, when
 *  nothing should paint at all. "retry" (ticket 16): `GET /access` has been
 *  failing long enough that silently spinning is no longer honest. */
export type GateStatus = "loading" | "hidden" | "connect" | "checking" | "redeem" | "retry";

export interface GateInputs {
  /** False while Privy or wallet-adapter is still restoring last session's wallet. */
  ready: boolean;
  connected: boolean;
  owner: string | undefined;
  access: AccessDto | null;
  /** The wallet that last passed the gate, from localStorage; "" when none. */
  rememberedOwner: string;
  /** Ticket 16: true once the access check has failed for long enough
   *  (`useAccessGate.ts`'s retry backoff) that "checking…" should become a
   *  retry control instead of spinning forever on an unreachable API. */
  fetchFailed?: boolean;
}

/** A returning wallet that passed the gate before stays hidden while
 *  `GET /access` is in flight instead of flashing the card. Access is never
 *  revoked once redeemed, so a stale answer can only be wrong for a wallet
 *  that never had it, and the fetch result still shows the card then. */
export function gateDecision(inputs: GateInputs): GateStatus {
  const { ready, connected, owner, access, rememberedOwner, fetchFailed } = inputs;
  if (!ready) return "loading";
  if (!connected) return "connect";
  if (access === null) {
    if (owner !== undefined && owner === rememberedOwner) return "hidden";
    return fetchFailed ? "retry" : "checking";
  }
  return access.allowed ? "hidden" : "redeem";
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
