/**
 * Owns the invite gate's state (ticket 09): the access check, the code
 * field, and sign-and-redeem. AccessGate.tsx only reads what this returns,
 * so the designer can restyle the modal without touching any of this.
 */
import { utils as anchorUtils } from "@anchor-lang/core";
import { useCallback, useEffect, useState } from "react";

import { fetchAccess, redeemAccess, type AccessDto } from "./api.js";
import {
  accessMessage,
  classifyRedeemError,
  gateDecision,
  inviteCodeFromSearch,
  normalizeInviteCode,
  type GateStatus,
} from "./access.js";

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

export function useAccessGate(options: AccessGateOptions): AccessGateState {
  const { baseUrl, owner, connected, connect, signMessage } = options;
  const [access, setAccess] = useState<AccessDto | null>(null);
  // Read once at mount so it survives the connect flow (this component stays
  // mounted for the app's whole session; connecting never remounts it).
  const [code, setCode] = useState(() => inviteCodeFromSearch(window.location.search));
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

  const submit = useCallback(() => {
    const wallet = owner;
    const trimmed = normalizeInviteCode(code);
    if (!wallet || !signMessage || !trimmed) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const bytes = await signMessage(
          new TextEncoder().encode(accessMessage(wallet, trimmed)),
        );
        const signature = anchorUtils.bytes.bs58.encode(bytes);
        const result = await redeemAccess(baseUrl, wallet, trimmed, signature);
        if (result.ok) {
          setAccess(result.data);
        } else {
          setError(classifyRedeemError(result.status, result.reason));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [owner, code, signMessage, baseUrl]);

  return {
    status: gateDecision(connected, access),
    code,
    setCode,
    busy,
    error,
    connect,
    submit,
  };
}
