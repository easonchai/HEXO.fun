/**
 * Ticket 09: a plain, unstyled modal that covers and blocks the whole page
 * until `GET /access/:wallet` says allowed. No close button. The designer
 * restyles this later, so it only carries the layout the "covers the whole
 * page, no click-through" requirement needs; see useAccessGate.ts for the
 * logic and access.ts for the pure pieces of it.
 */
import type { CSSProperties, ReactNode } from "react";

import { apiBaseUrl } from "./api.js";
import { useAccessGate } from "./useAccessGate.js";
import { useGameSigner } from "./wallets.js";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  background: "rgba(0, 0, 0, 0.85)",
  color: "#fff",
  textAlign: "center",
  padding: "1rem",
};

export function AccessGate({ children }: { children: ReactNode }) {
  const signer = useGameSigner();
  const gate = useAccessGate({
    baseUrl: apiBaseUrl(),
    owner: signer.publicKey?.toBase58(),
    connected: signer.connected,
    connect: signer.connect,
    signMessage: signer.signMessage,
  });

  return (
    <>
      {children}
      {gate.status === "hidden" ? null : (
        <div style={overlayStyle} data-testid="access-gate">
          {gate.status === "connect" ? (
            <>
              <p>Connect your wallet to continue.</p>
              <button type="button" onClick={gate.connect} data-testid="access-gate-connect">
                CONNECT
              </button>
            </>
          ) : gate.status === "checking" ? (
            <p>Checking access…</p>
          ) : (
            <>
              <p>Enter your invite code.</p>
              <input
                value={gate.code}
                onChange={(event) => gate.setCode(event.target.value)}
                placeholder="INVITE CODE"
                data-testid="access-gate-input"
              />
              <button
                type="button"
                disabled={gate.busy || gate.code.trim() === ""}
                onClick={gate.submit}
                data-testid="access-gate-submit"
              >
                {gate.busy ? "CHECKING…" : "SUBMIT"}
              </button>
              {gate.error ? (
                <p data-testid="access-gate-error">{gate.error}</p>
              ) : null}
            </>
          )}
        </div>
      )}
    </>
  );
}
