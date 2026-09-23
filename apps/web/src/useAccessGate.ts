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
  const { baseUrl, owner, connected, connect, signMessage } = options;
  const [access, setAccess] = useState<AccessDto | null>(null);
  // Read once at mount so it survives the connect flow (this component stays
  // mounted for the app's whole session; connecting never remounts it).
  const [code, setCode] = useState(() => inviteCodeFromSearch(window.location.search));
  const [refCode, setRefCode] = useState(() => captureRefCode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAccess(null);
    if (!owner) return;
    let cancelled = false;
    const controller = new AbortController();
    void fetchAccess(baseUrl, owner, controller.signal).then((result) => {
      if (!cancelled && result.ok) setAccess(result.data);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [baseUrl, owner]);

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
  // wallet that already has access skips the redeem and the gate just closes.
  const [pending, setPending] = useState(false);
  const status = gateDecision(connected, access);
  useEffect(() => {
    if (!pending || status === "connect" || status === "checking") return;
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
    if (status !== "hidden" || !owner || !signMessage || !refCode) return;
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
  }, [status, owner, signMessage, refCode, baseUrl]);

  const submit = useCallback(() => {
    if (normalizeInviteCode(code) === "") return;
    if (connected) {
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
    busy: busy || (pending && connected),
    error,
    connect,
    submit,
  };
}
