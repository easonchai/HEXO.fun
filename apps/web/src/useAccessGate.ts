/**
 * Owns the invite gate's state (ticket 09): the access check, the code
 * field, and sign-and-redeem. AccessGate.tsx only reads what this returns,
 * so the designer can restyle the modal without touching any of this.
 */
import { utils as anchorUtils } from "@anchor-lang/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { applyReferral, fetchAccess, redeemAccess, type AccessDto } from "./api.js";
import {
  accessMessage,
  accessRetryDelayMs,
  checkErrorMessage,
  classifyRedeemError,
  gateDecision,
  inviteCodeFromSearch,
  normalizeInviteCode,
  type GateStatus,
} from "./access.js";
import {
  applyReferralMessage,
  classifyApplyResponse,
  refCodeFromSearch,
  referralApplyPlan,
} from "./referrals.js";

/** The one-line notice that explains the `?ref=` signature prompt
 *  (pre-mainnet review): shown while the wallet is asked to sign and for a
 *  moment after the backend confirms. */
export interface ReferralNotice {
  kind: "applying" | "applied";
  code: string;
}

export interface AccessGateState {
  status: GateStatus;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  /** The failed access check's line, while `status` is "failed". */
  checkError: string | null;
  /** Re-runs the access check now, ahead of the automatic backoff. */
  retryCheck: () => void;
  connect: () => void;
  submit: () => void;
  referralNotice: ReferralNotice | null;
}

export interface AccessGateOptions {
  baseUrl: string;
  /** Connected wallet's base58 address; undefined until one connects. */
  owner: string | undefined;
  connected: boolean;
  connect: () => void;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
}

const REF_CODE_STORAGE_KEY = "hexo-ref-code";
/** sessionStorage: the wallet+code pairs this tab already asked to sign
 *  for, so a declined prompt is not repeated until the next session. */
const REF_ATTEMPTED_STORAGE_KEY = "hexo-ref-attempted";
/** How long "Referral code X applied" stays up. */
const APPLIED_NOTICE_MS = 4_000;

/** `?ref=CODE` (spec.md "?ref= capture"), captured into localStorage the
 *  moment it's seen so it survives the gate flow, a wallet connect and a
 *  reload, and stripped from the URL right after. With no `?ref=` on this
 *  load, falls back to whatever an earlier visit already stored. Wrapped in
 *  try/catch: a private tab with storage blocked just does not remember the
 *  code past this page view. */
function captureRefCode(): string {
  const fromUrl = refCodeFromSearch(window.location.search);
  if (!fromUrl) {
    try {
      return window.localStorage.getItem(REF_CODE_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  }
  const code = normalizeInviteCode(fromUrl);
  try {
    window.localStorage.setItem(REF_CODE_STORAGE_KEY, code);
  } catch {
    // Storage blocked: the code still applies this render, just does not
    // survive a reload.
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("ref");
  window.history.replaceState({}, "", url);
  return code;
}

function clearStoredRefCode(): void {
  try {
    window.localStorage.removeItem(REF_CODE_STORAGE_KEY);
  } catch {
    // nothing to clean up if it never wrote
  }
}

function loadAttempted(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(REF_ATTEMPTED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function saveAttempted(keys: Set<string>): void {
  try {
    window.sessionStorage.setItem(REF_ATTEMPTED_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage blocked: the in-memory set still holds for this page view.
  }
}

export function useAccessGate(options: AccessGateOptions): AccessGateState {
  const { baseUrl, owner, connected, connect, signMessage } = options;
  const [access, setAccess] = useState<AccessDto | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkNonce, setCheckNonce] = useState(0);
  // Read once at mount so it survives the connect flow (this component stays
  // mounted for the app's whole session; connecting never remounts it).
  const [code, setCode] = useState(() => inviteCodeFromSearch(window.location.search));
  const [refCode, setRefCode] = useState(() => captureRefCode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The access check. A failed fetch (pre-mainnet review) used to set
  // nothing and leave the gate on "Checking…" for good; it now records the
  // reason, re-checks on a backoff, and `retryCheck` bumps the nonce to
  // start over at once.
  useEffect(() => {
    setAccess(null);
    setCheckError(null);
    if (!owner) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const controller = new AbortController();
    const run = () => {
      void fetchAccess(baseUrl, owner, controller.signal).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAccess(result.data);
          setCheckError(null);
          return;
        }
        setCheckError(checkErrorMessage(result.reason));
        timer = window.setTimeout(run, accessRetryDelayMs(attempt));
        attempt += 1;
      });
    };
    run();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [baseUrl, owner, checkNonce]);

  const retryCheck = useCallback(() => setCheckNonce((n) => n + 1), []);

  const redeem = useCallback(() => {
    const wallet = owner;
    const trimmed = normalizeInviteCode(code);
    if (!wallet || !signMessage || !trimmed) return;
    setBusy(true);
    setError(null);
    const ref = refCode || undefined;
    void (async () => {
      try {
        const bytes = await signMessage(
          new TextEncoder().encode(accessMessage(wallet, trimmed, ref)),
        );
        const signature = anchorUtils.bytes.bs58.encode(bytes);
        const result = await redeemAccess(baseUrl, wallet, trimmed, signature, ref);
        if (result.ok) {
          setAccess(result.data);
          if (ref) {
            clearStoredRefCode();
            setRefCode("");
          }
        } else {
          setError(classifyRedeemError(result.status, result.reason));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [owner, code, signMessage, baseUrl, refCode]);

  // The code comes first: SUBMIT while disconnected opens the wallet, then
  // redeems once the access check says this wallet still needs a code. A
  // wallet that already has access skips the redeem and the gate just
  // closes. A failed check keeps the submission pending: the automatic
  // re-check resolves it either way.
  const [pending, setPending] = useState(false);
  const status = gateDecision(connected, access, checkError);
  useEffect(() => {
    if (!pending || status === "connect" || status === "checking" || status === "failed") return;
    setPending(false);
    if (status === "redeem") redeem();
  }, [pending, status, redeem]);

  // A friend already past the gate who opens a `?ref=` link before
  // depositing applies it with its own signature once connected (spec.md
  // "?ref= capture", user story 32). `referralApplyPlan` decides whether to
  // prompt at all: never for an "existing depositor" (the backend refuses
  // those), and at most once per session per wallet+code, remembered in
  // sessionStorage before the prompt so a declined signature is not asked
  // again on the next render or reload. The backend's answer goes through
  // `classifyApplyResponse`: a permanent refusal drops the stored code the
  // same way a success does. `signMessage` rides in a ref so the effect
  // keys on whether a signer exists, not on its identity.
  const [referralNotice, setReferralNotice] = useState<ReferralNotice | null>(null);
  const attemptedRef = useRef<Set<string> | null>(null);
  const signMessageRef = useRef(signMessage);
  signMessageRef.current = signMessage;
  const canSign = signMessage !== undefined;
  useEffect(() => {
    if (status !== "hidden" || !canSign) return;
    attemptedRef.current ??= loadAttempted();
    const attempted = attemptedRef.current;
    const plan = referralApplyPlan({
      owner,
      refCode,
      access,
      attempted: (key) => attempted.has(key),
    });
    if (plan.kind !== "apply") return;
    const sign = signMessageRef.current;
    const wallet = owner;
    const codeToApply = refCode;
    if (!sign || !wallet) return;
    attempted.add(plan.key);
    saveAttempted(attempted);
    // No cancellation: the key is already marked, so a re-run (StrictMode's
    // double effect, a dep change mid-flight) skips rather than re-prompts,
    // and the flight below settles its own notice with functional updates.
    const clearNotice = (kind: ReferralNotice["kind"]) =>
      setReferralNotice((current) =>
        current?.kind === kind && current.code === codeToApply ? null : current,
      );
    setReferralNotice({ kind: "applying", code: codeToApply });
    void (async () => {
      try {
        const bytes = await sign(
          new TextEncoder().encode(applyReferralMessage(wallet, codeToApply)),
        );
        const signature = anchorUtils.bytes.bs58.encode(bytes);
        const outcome = classifyApplyResponse(
          await applyReferral(baseUrl, wallet, codeToApply, signature),
        );
        if (outcome !== "transient") {
          clearStoredRefCode();
          setRefCode("");
        }
        if (outcome === "applied") {
          setReferralNotice({ kind: "applied", code: codeToApply });
          window.setTimeout(() => clearNotice("applied"), APPLIED_NOTICE_MS);
        } else {
          clearNotice("applying");
        }
      } catch {
        // A declined signature or a dropped request: the code stays stored
        // for the next session, and this session will not ask again.
        clearNotice("applying");
      }
    })();
  }, [status, owner, canSign, refCode, access, baseUrl]);

  const submit = useCallback(() => {
    if (normalizeInviteCode(code) === "") return;
    if (connected) {
      // A submission still pending from a failed check must not redeem a
      // second time once that check lands.
      setPending(false);
      redeem();
      return;
    }
    setError(null);
    setPending(true);
    connect();
  }, [code, connected, redeem, connect]);

  return {
    status,
    code,
    setCode,
    busy: busy || (pending && connected && status === "checking"),
    error,
    checkError,
    retryCheck,
    connect,
    submit,
    referralNotice,
  };
}
