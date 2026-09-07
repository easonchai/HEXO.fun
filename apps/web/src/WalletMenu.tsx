import { useEffect, useRef, useState } from "react";

type Props = {
  address: string;
  tickets: string;
  balance: string;
  symbol: string;
  addressCopied: boolean;
  onCopy: (address: string) => void;
  onDisconnect: () => void;
};

/**
 * Topbar wallet pill plus its dropdown. The pill keeps `connect-button` and
 * its `Copy <address>` title because demo.spec.ts reads the address off it.
 * Closes on outside click, Escape, and after Disconnect; Copy keeps it open
 * so the "Copied" flip is visible.
 */
export function WalletMenu({
  address,
  tickets,
  balance,
  symbol,
  addressCopied,
  onCopy,
  onDisconnect,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

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

function DisconnectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 8h8M11 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
