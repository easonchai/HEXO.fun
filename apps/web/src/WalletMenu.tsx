import { useEffect, useRef, useState } from "react";

import { apiBaseUrl, requestFaucet } from "./api.js";

type Props = {
  address: string;
  tickets: string;
  balance: string;
  symbol: string;
  addressCopied: boolean;
  onCopy: (address: string) => void;
  /** Called after the faucet lands so the balance row re-reads the chain. */
  onFunded: () => void;
  onDisconnect: () => void;
};

/** Faucet button label state. `wait` counts down the per-owner cooldown. */
type Faucet =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "sent" }
  | { kind: "wait"; seconds: number }
  | { kind: "error"; reason: string };

/**
 * Topbar wallet pill plus its dropdown. The pill keeps `connect-button` and
 * its `Copy <address>` title because demo.spec.ts reads the address off it.
 * Closes on outside click, Escape, and after Disconnect; Copy and Faucet keep
 * it open so the "Copied" / "Sent" flip is visible.
 */
export function WalletMenu({
  address,
  tickets,
  balance,
  symbol,
  addressCopied,
  onCopy,
  onFunded,
  onDisconnect,
}: Props) {
  const [open, setOpen] = useState(false);
  const [faucet, setFaucet] = useState<Faucet>({ kind: "idle" });
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (faucet.kind !== "wait") return;
    const id = setTimeout(
      () =>
        setFaucet(
          faucet.seconds <= 1
            ? { kind: "idle" }
            : { kind: "wait", seconds: faucet.seconds - 1 },
        ),
      1000,
    );
    return () => clearTimeout(id);
  }, [faucet]);

  const pullFaucet = async () => {
    setFaucet({ kind: "busy" });
    const result = await requestFaucet(apiBaseUrl(), address);
    if (result.ok) {
      setFaucet({ kind: "sent" });
      onFunded();
    } else if ("retryAfterSeconds" in result) {
      setFaucet({ kind: "wait", seconds: result.retryAfterSeconds });
    } else {
      setFaucet({ kind: "error", reason: result.reason });
    }
  };

  const faucetLabel = {
    idle: `Get ${symbol}`,
    busy: "Sending…",
    sent: "Sent",
    wait: faucet.kind === "wait" ? `Faucet in ${faucet.seconds}s` : "",
    error: faucet.kind === "error" ? `Faucet failed: ${faucet.reason}` : "",
  }[faucet.kind];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="wallet-menu-root" data-testid="wallet-connector">
      <button
        type="button"
        className="btn-connect"
        data-testid="connect-button"
        title={`Copy ${address}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {`${address.slice(0, 4)}…${address.slice(-4)}`}
      </button>
      {open ? (
        <div className="wallet-menu" role="menu" data-testid="wallet-menu">
          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item"
            data-testid="copy-address-button"
            onClick={() => onCopy(address)}
          >
            <CopyIcon />
            <span className="wallet-menu-item-body">
              <span className="wallet-menu-item-label">
                {addressCopied ? "Copied" : "Copy address"}
              </span>
              <span className="wallet-menu-address">
                {`${address.slice(0, 8)}…${address.slice(-8)}`}
              </span>
            </span>
          </button>
          <div className="wallet-menu-row" data-testid="wallet-menu-tickets">
            <span className="wallet-menu-row-label">Tickets</span>
            <span className="wallet-menu-row-value">{tickets}</span>
          </div>
          <div className="wallet-menu-row" data-testid="wallet-menu-balance">
            <span className="wallet-menu-row-label">{symbol}</span>
            <span className="wallet-menu-row-value">{balance}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item"
            data-testid="faucet"
            disabled={faucet.kind === "busy" || faucet.kind === "wait"}
            onClick={() => void pullFaucet()}
          >
            <FaucetIcon />
            <span className="wallet-menu-item-label">{faucetLabel}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="wallet-menu-item wallet-menu-item-danger"
            data-testid="disconnect-button"
            onClick={() => {
              setOpen(false);
              onDisconnect();
            }}
          >
            <DisconnectIcon />
            <span className="wallet-menu-item-label">Disconnect</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function FaucetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.5s-4 4.2-4 7a4 4 0 0 0 8 0c0-2.8-4-7-4-7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function DisconnectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 8h8M11 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
