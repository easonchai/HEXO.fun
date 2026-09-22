/**
 * Invite gate (Figma 141:52988, component 141:53126, input states 161:11865,
 * mobile 147:7608). A full-page blocking modal with no close button until
 * `GET /access/:wallet` says allowed. The code comes before the wallet:
 * SUBMIT connects first if needed. See useAccessGate.ts for the logic and
 * access.ts for the pure pieces of it.
 */
import type { ReactNode } from "react";

import { apiBaseUrl } from "./api.js";
import { LogoCog, LogoWordmark } from "./arena/Arena.js";
import { Star } from "./screens/Home.js";
import { useAccessGate } from "./useAccessGate.js";
import { useGameSigner } from "./wallets.js";

/** The landing page's waitlist form; it records signups and PostHog events. */
const WAITLIST_URL = "https://hexo-landing.vercel.app/";

export function AccessGate({ children }: { children: ReactNode }) {
  const signer = useGameSigner();
  const gate = useAccessGate({
    baseUrl: apiBaseUrl(),
    owner: signer.publicKey?.toBase58(),
    connected: signer.connected,
    connect: signer.connect,
    signMessage: signer.signMessage,
  });

  const checking = gate.status === "checking";
  const busy = gate.busy || checking;

  return (
    <>
      {children}
      {gate.status === "hidden" ? null : (
        <div className="invite-gate" data-testid="access-gate">
          <div className="invite-card" role="dialog" aria-modal="true" aria-labelledby="invite-title">
            <div className="invite-hero" aria-hidden="true">
              <img className="invite-textile" src="/invite-textile.svg" alt="" />
              <p className="invite-headline">
                Start Saving,
                <br />
                <span>Maybe Win</span>
              </p>
              <p className="invite-tagline">A NO-LOSS SAVING APP</p>
            </div>
            <div className="invite-form-pane">
              <img className="invite-textile invite-textile-mobile" src="/invite-textile.svg" alt="" aria-hidden="true" />
              <form
                className="invite-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  gate.submit();
                }}
              >
                <span className="invite-logo">
                  <LogoCog size={41.26} />
                  <LogoWordmark height={16.42} />
                </span>
                <div className="invite-intro">
                  <div className="invite-title-row">
                    <Star />
                    <h2 id="invite-title" className="invite-title">
                      Early <br className="invite-title-break" />
                      Access
                    </h2>
                    <Star />
                  </div>
                  <p className="invite-copy">Enter your invite code to get access to the platform</p>
                </div>
                <div className="invite-field">
                  <label className="invite-label" htmlFor="invite-code">
                    INVITE CODE
                  </label>
                  <input
                    id="invite-code"
                    className={`invite-input${gate.error ? " error" : ""}`}
                    value={gate.code}
                    onChange={(event) => gate.setCode(event.target.value)}
                    placeholder="ENTER INVITE CODE"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={gate.error ? true : undefined}
                    aria-describedby={gate.error ? "invite-error" : undefined}
                    data-testid="access-gate-input"
                  />
                  {gate.error ? (
                    <p id="invite-error" className="invite-error" role="alert" data-testid="access-gate-error">
                      {gate.error}
                    </p>
                  ) : null}
                  <a className="invite-waitlist" href={WAITLIST_URL} target="_blank" rel="noopener noreferrer">
                    Don’t have an access code?
                  </a>
                </div>
                <button
                  type="submit"
                  className="invite-submit"
                  disabled={busy || gate.code.trim() === ""}
                  data-testid="access-gate-submit"
                >
                  {busy ? "Checking…" : "Submit"}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
