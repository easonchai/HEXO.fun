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
  canSubmitAccess,
  classifyRedeemError,
  gateDecision,
  inviteCodeFromSearch,
  normalizeInviteCode,
  type GateStatus,
} from "./access.js";
import { applyReferralMessage, refCodeFromSearch } from "./referrals.js";

export interface AccessGateState {
  status: GateStatus;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  error: string | null;
  connect: () => void;
  submit: () => void;
  /** Ticket 16: forces an immediate `GET /access` retry from the gate's own
   *  retry control, resetting the backoff. */
  retry: () => void;
  /** beta-launch-fixes ticket 17: the one-time terms/risk/privacy checkbox.
   *  Already true (and hidden by AccessGate.tsx) for a wallet this browser
   *  remembers acknowledging before. */
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
}

export interface AccessGateOptions {
  baseUrl: string;
  /** Connected wallet's base58 address; undefined until one connects. */
  owner: string | undefined;
  /** False while the wallet layer is still restoring last session's wallet. */
  ready: boolean;
  connected: boolean;
  connect: () => void;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
}

/** Ticket 16: automatic retries keep going forever; the retry control only
 *  appears once this much time has passed with no answer. */
const RETRY_CONTROL_AFTER_MS = 10_000;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 10_000;

const REF_CODE_STORAGE_KEY = "hexo-ref-code";
/** The wallet that last passed the gate, so a reload does not flash the
 *  card while `GET /access` confirms it again. */
const ACCESS_OWNER_STORAGE_KEY = "hexo-access-owner";

function readRememberedOwner(): string {
  try {
    return window.localStorage.getItem(ACCESS_OWNER_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberOwner(owner: string): void {
  try {
    window.localStorage.setItem(ACCESS_OWNER_STORAGE_KEY, owner);
  } catch {
    // Storage blocked: the next reload shows the card once more, nothing worse.
  }
}

/** beta-launch-fixes ticket 17: the wallet that already checked the terms
 *  acknowledgement box in this browser, so a reload (or a failed redeem
 *  attempt) does not ask it to check the box again. The backend is the real
 *  record once redeemed; this is only about not re-prompting mid-flow. */
const TERMS_ACK_STORAGE_KEY = "hexo-terms-ack-owner";

function readAcknowledgedOwner(): string {
  try {
    return window.localStorage.getItem(TERMS_ACK_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberAcknowledged(owner: string): void {
  try {
    window.localStorage.setItem(TERMS_ACK_STORAGE_KEY, owner);
  } catch {
    // Storage blocked: the checkbox just shows unchecked again next time.
  }
}

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

export function useAccessGate(options: AccessGateOptions): AccessGateState {
  const { baseUrl, owner, ready, connected, connect, signMessage } = options;
  const [access, setAccess] = useState<AccessDto | null>(null);
  const [rememberedOwner, setRememberedOwner] = useState(() => readRememberedOwner());
  useEffect(() => {
    if (!owner || !access?.allowed || owner === rememberedOwner) return;
    rememberOwner(owner);
    setRememberedOwner(owner);
  }, [owner, access, rememberedOwner]);
  // Read once at mount so it survives the connect flow (this component stays
  // mounted for the app's whole session; connecting never remounts it).
  const [code, setCode] = useState(() => inviteCodeFromSearch(window.location.search));
  const [refCode, setRefCode] = useState(() => captureRefCode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // beta-launch-fixes ticket 17: pre-checked (and hidden by AccessGate.tsx)
  // once this owner is the one this browser remembers acknowledging.
  const [acknowledged, setAcknowledged] = useState(
    () => readAcknowledgedOwner() !== "" && readAcknowledgedOwner() === owner,
  );
  useEffect(() => {
    if (owner && readAcknowledgedOwner() === owner) setAcknowledged(true);
  }, [owner]);
  // Ticket 16: `GET /access` retries with backoff on its own; `fetchFailed`
  // only flips once ten seconds of that have passed with no answer, so
  // `gateDecision` shows a retry control instead of spinning forever on an
  // unreachable API. `retryNonce` lets the control's own click force an
  // immediate retry, resetting the backoff.
  const [fetchFailed, setFetchFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    setAccess(null);
    setFetchFailed(false);
    if (!owner) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();

    const tick = (): void => {
      void fetchAccess(baseUrl, owner, controller.signal).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setAccess(result.data);
          setFetchFailed(false);
          return;
        }
        if (Date.now() - startedAt >= RETRY_CONTROL_AFTER_MS) setFetchFailed(true);
        attempt += 1;
        const delay = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_MAX_MS);
        timer = setTimeout(tick, delay);
      });
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    };
  }, [baseUrl, owner, retryNonce]);

  const retryAccess = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);

  const redeem = useCallback(() => {
    const wallet = owner;
    const trimmed = normalizeInviteCode(code);
    if (!wallet || !signMessage || !canSubmitAccess(code, acknowledged)) return;
    setBusy(true);
    setError(null);
    const ref = refCode || undefined;
    void (async () => {
      try {
        const bytes = await signMessage(
          new TextEncoder().encode(accessMessage(wallet, trimmed, ref)),
        );
        const signature = anchorUtils.bytes.bs58.encode(bytes);
        const result = await redeemAccess(baseUrl, wallet, trimmed, signature, true, ref);
        if (result.ok) {
          setAccess(result.data);
          rememberAcknowledged(wallet);
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
  }, [owner, code, signMessage, baseUrl, refCode, acknowledged]);

  // The code comes first: SUBMIT while disconnected opens the wallet, then
  // redeems once the access check says this wallet still needs a code. A
  // wallet that already has access skips the redeem and the gate just closes.
  const [pending, setPending] = useState(false);
  const status = gateDecision({ ready, connected, owner, access, rememberedOwner, fetchFailed });
  useEffect(() => {
    if (!pending || status === "loading" || status === "connect" || status === "checking")
      return;
    setPending(false);
    if (status === "redeem") redeem();
  }, [pending, status, redeem]);

  // A friend already past the gate who opens a `?ref=` link before
  // depositing applies it with its own signature once connected (spec.md
  // "?ref= capture", user story 32). `applying` guards against firing twice
  // for the same pending code; a failed attempt (signature declined,
  // network) resets it so a later render can retry, and never surfaces an
  // error — the web quietly ignores `applied: false` the same way.
  const applyingRef = useRef(false);
  useEffect(() => {
    if (!access?.allowed || !owner || !signMessage || !refCode) return;
    if (applyingRef.current) return;
    applyingRef.current = true;
    void (async () => {
      try {
        const bytes = await signMessage(
          new TextEncoder().encode(applyReferralMessage(owner, refCode)),
        );
        const signature = anchorUtils.bytes.bs58.encode(bytes);
        const result = await applyReferral(baseUrl, owner, refCode, signature);
        if (result.ok) {
          clearStoredRefCode();
          setRefCode("");
        }
      } catch {
        // Best-effort: a rejected signature or a dropped request just leaves
        // the code stored for the next chance to apply it.
      } finally {
        applyingRef.current = false;
      }
    })();
  }, [access, owner, signMessage, refCode, baseUrl]);

  const submit = useCallback(() => {
    if (!canSubmitAccess(code, acknowledged)) return;
    if (connected) {
      redeem();
      return;
    }
    setError(null);
    setPending(true);
    connect();
  }, [code, connected, redeem, connect, acknowledged]);

  return {
    status,
    code,
    setCode,
    busy: busy || (pending && connected),
    error,
    connect,
    submit,
    retry: retryAccess,
    acknowledged,
    setAcknowledged,
  };
}
