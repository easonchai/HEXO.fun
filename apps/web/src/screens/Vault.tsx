/**
 * VAULT tab: the Figma "Deposit" frame. One widget with DEPOSIT / WITHDRAW
 * tabs on the HOME halftone background. The program is the custody boundary.
 * WITHDRAW sends `request_withdraw`, which deducts Principal and Tickets now
 * and pays out after the epoch ends (ADR 0009). The pending row below the
 * widget carries that wait: the amount, the day it pays in, and a "pay out
 * now" button that sends the permissionless `process_withdraw` when the
 * operator has not.
 *
 * Ticket 07: `currentEpoch` comes from App's one `GET /state` poll instead
 * of a duplicate `/epochs/current` poll of its own; `onDone` tightens that
 * poll (see `useStatePoll.ts` `kick`) instead of triggering a chain re-read.
 */
import { useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import {
  deposit,
  processWithdraw,
  requestWithdraw,
  type TxSigner,
} from "../actions.js";
import type { CurrentEpochDto } from "../api.js";
import { LogoCog } from "../arena/Arena.js";
import type { HexVaultProgram } from "../chain.js";
import {
  addCapped,
  clampDecimals,
  formatAtomic2,
  parseAtomic,
  pendingWithdrawal,
  previewWithdraw,
} from "../lib/money.js";
import type { PoolLike } from "../read.js";
import { GlyphRow } from "./Home.js";

const DECIMALS = 6;
const SYMBOL = "USDC";
const ONE = 10n ** BigInt(DECIMALS);
/**
 * The input, the pills and MAX all stay at two decimals so what the rows show
 * is what gets signed. Up to 0.009999 USDC of game dust in Tickets can
 * stay behind on a MAX withdraw; worth less than a cent.
 */
const INPUT_DECIMALS = 2;
/** The Figma quick pills: each adds this many whole USDC. */
const QUICK_ADDS = [50n, 100n, 500n] as const;

/**
 * `InsufficientVaultLiquidity` (6036): the admin has not brought the
 * principal back from the lending venue yet. Nothing the depositor did, and
 * nothing they can fix, so the raw Anchor error would only alarm them.
 */
const VAULT_SHORT_CODE = "6036";
const VAULT_SHORT_NOTE =
  "The vault is being topped up. Try the payout again in a few minutes.";
/**
 * `NothingPending` (6038): the operator's crank paid this withdrawal before
 * the click landed. The money is already in the wallet.
 */
const NOTHING_PENDING_CODE = "6038";
const NOTHING_PENDING_NOTE = "Already paid out. Refreshing your balance.";

export const payoutError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes(VAULT_SHORT_CODE) || text.includes("InsufficientVaultLiquidity")) {
    return VAULT_SHORT_NOTE;
  }
  if (text.includes(NOTHING_PENDING_CODE) || text.includes("NothingPending")) {
    return NOTHING_PENDING_NOTE;
  }
  return text;
};

export type VaultMode = "deposit" | "withdraw";
type Mode = VaultMode;

export interface VaultScreenProps {
  /** Null until a wallet is connected; the CTA then reads CONNECT WALLET. */
  program: HexVaultProgram | null;
  owner: PublicKey | null;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  principal: bigint;
  entries: bigint;
  walletBalance: bigint;
  paused: boolean;
  currentEpoch: CurrentEpochDto | null;
  /** Requested but unpaid Principal; 0 when nothing is pending. */
  pendingWithdraw: bigint;
  /** The epoch that pending amount was requested in, so the day it pays after. */
  pendingEpoch: bigint;
  /**
   * Which tab the widget opens on. The dashboard's two buttons are the only
   * way in, and they arrive with an intent already; App unmounts the screen on
   * every tab change, so this is read fresh on each arrival.
   */
  initialMode?: Mode | undefined;
  onConnect: () => void;
  onDone: () => void;
  /** "Play HEXO" on the deposit-confirmed modal: App switches to the MINE tab. */
  onPlay: () => void;
}

export function Vault(props: VaultScreenProps) {
  const {
    program,
    owner,
    sendTransaction,
    pool,
    principal,
    entries,
    walletBalance,
    paused,
    currentEpoch,
    pendingWithdraw,
    pendingEpoch,
    initialMode,
    onConnect,
    onDone,
    onPlay,
  } = props;
  // Two decimals everywhere, including what the pills write into the input
  // (see INPUT_DECIMALS).
  const fmt2 = (value: bigint) => formatAtomic2(value, DECIMALS);

  const [mode, setMode] = useState<Mode>(initialMode ?? "deposit");
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );
  /** Atomic amount of the deposit that just landed; null closes the modal. */
  const [confirmed, setConfirmed] = useState<bigint | null>(null);
  /**
   * A `process_withdraw` has been sent and the read model has not caught up.
   * Keyed on the pending amount so the flag clears itself the moment the
   * payout lands (or a fresh request books a different amount).
   */
  const [payoutSent, setPayoutSent] = useState<bigint | null>(null);

  const connected = owner !== null && program !== null && pool !== null;
  const amount = parseAtomic(amountText, DECIMALS);
  /**
   * What the pills clamp to: wallet on deposit, Principal on withdraw.
   * `request_withdraw` only checks Principal now (ADR 0009), so Tickets
   * spent in the game no longer hold any of it back.
   */
  const cap = mode === "deposit" ? walletBalance : principal;

  // The payout landed (or the request was never there): drop the flag, so a
  // later request for the same amount does not inherit this one's state.
  useEffect(() => {
    if (pendingWithdraw === 0n) setPayoutSent(null);
  }, [pendingWithdraw]);

  const pending = pendingWithdrawal(
    pendingWithdraw,
    pendingEpoch,
    currentEpoch ? BigInt(currentEpoch.id) : null,
    payoutSent !== null && payoutSent === pendingWithdraw,
  );

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setAmountText("");
    setNote(null);
  };

  const addQuick = (units: bigint) =>
    setAmountText(fmt2(addCapped(amount ?? 0n, units * ONE, connected ? cap : null)));

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      const signature = await action();
      // Deposit gets the confirmed modal; withdraw keeps the inline note.
      if (label === "Deposit" && amount !== null) {
        setConfirmed(amount);
      } else {
        setNote({
          tone: "ok",
          text: `${label}: ${signature.slice(0, 16)}…`,
        });
      }
      setAmountText("");
      onDone();
    } catch (error) {
      setNote({
        tone: "err",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const overCap = connected && amount !== null && amount > cap;
  const underMin =
    mode === "deposit" && pool !== null && amount !== null && amount < pool.minDeposit;
  const withdrawPreview =
    mode === "withdraw" && amount !== null ? previewWithdraw(entries, amount) : null;

  const submit = () => {
    if (!connected || !amount) return;
    const signer: TxSigner = { publicKey: owner, sendTransaction };
    if (mode === "deposit") {
      void run("Deposit", () => deposit(program, signer, pool, amount));
    } else {
      void run("Withdraw requested", () =>
        requestWithdraw(program, signer, pool, amount),
      );
    }
  };

  const payOutNow = async () => {
    if (!connected) return;
    setBusy(true);
    setNote(null);
    setPayoutSent(pendingWithdraw);
    try {
      await processWithdraw(program, { publicKey: owner, sendTransaction }, pool);
      setNote({ tone: "ok", text: "Payout sent." });
      onDone();
    } catch (error) {
      const text = payoutError(error);
      // Already paid by the operator: the read model is stale, so refresh it
      // the same way a successful payout does instead of offering the button again.
      if (text === NOTHING_PENDING_NOTE) {
        setNote({ tone: "ok", text });
        onDone();
      } else {
        setPayoutSent(null);
        setNote({ tone: "err", text });
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    connected &&
    !busy &&
    !!amount &&
    amount > 0n &&
    !overCap &&
    !underMin &&
    !(mode === "deposit" && paused);

  const ctaText = !connected
    ? "CONNECT WALLET"
    : busy
      ? "SIGNING…"
      : mode === "deposit" && paused
        ? "POOL PAUSED"
        : mode.toUpperCase();

  return (
    <div className="vault" data-testid="vault-screen">
      {/* Pre-dithered checkmark coin (scripts/dither-video.mjs). Without autoplay the poster stays. */}
      <video
        className="home-bg"
        src="/vault-bg.mp4"
        poster="/vault-bg.png"
        autoPlay={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <div className="vault-row">
        <GlyphRow />
        <section className="vault-widget" aria-label="Deposit or withdraw">
          <div className="vault-tabs" role="tablist">
            {(["deposit", "withdraw"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={mode === candidate}
                className={`vault-tab${mode === candidate ? " active" : ""}`}
                data-testid={`vault-tab-${candidate}`}
                onClick={() => switchMode(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>

          <div className="vault-body">
            <label className="vault-amount">
              <span className="vault-amount-dollar" aria-hidden="true">
                $
              </span>
              <input
                value={amountText}
                placeholder="0"
                onChange={(event) =>
                  setAmountText(clampDecimals(event.target.value, INPUT_DECIMALS))
                }
                inputMode="decimal"
                data-testid={`${mode}-input`}
                aria-label={`${mode} amount`}
              />
              <span className="vault-amount-symbol">{SYMBOL}</span>
              <span className="vault-amount-available" data-testid="withdrawable-now">
                {mode === "deposit"
                  ? `Available ${fmt2(walletBalance)} ${SYMBOL}`
                  : `Withdrawable at day end ${fmt2(principal)} ${SYMBOL}`}
              </span>
            </label>

            <div className="vault-quick">
              {QUICK_ADDS.map((units) => (
                <button
                  key={units.toString()}
                  type="button"
                  className="vault-pill"
                  onClick={() => addQuick(units)}
                >
                  +${units.toString()}
                </button>
              ))}
              <button
                type="button"
                className="vault-pill"
                onClick={() => setAmountText(fmt2(cap))}
              >
                MAX
              </button>
            </div>

            <dl className="vault-rows">
              {mode === "deposit" ? (
                <div className="vault-line">
                  <dt>Tickets</dt>
                  <dd>{fmt2(amount ?? 0n)}</dd>
                </div>
              ) : (
                <>
                  <div className="vault-line">
                    <dt>You receive at day end</dt>
                    <dd>
                      {fmt2(amount ?? 0n)} {SYMBOL}
                    </dd>
                  </div>
                  <div className="vault-line">
                    <dt>Tickets after</dt>
                    <dd>
                      {fmt2(withdrawPreview ? withdrawPreview.entriesAfter : entries)}
                    </dd>
                  </div>
                </>
              )}
              {pending.kind === "none" ? null : (
                <div className="vault-line" data-testid="pending-withdraw">
                  <dt>
                    Pending {fmt2(pending.amount)} {SYMBOL}
                  </dt>
                  <dd className="vault-pending-state">
                    <span data-testid="pending-withdraw-state">
                      {pending.kind === "pending"
                        ? `pays out after day #${pending.epoch} ends`
                        : pending.kind === "processing"
                          ? "paying out…"
                          : "ready"}
                    </span>
                    {pending.kind === "due" ? (
                      <button
                        type="button"
                        className="vault-pill vault-payout"
                        data-testid="pay-out-now"
                        disabled={busy}
                        onClick={() => void payOutNow()}
                      >
                        PAY OUT NOW
                      </button>
                    ) : null}
                  </dd>
                </div>
              )}
            </dl>

            <button
              type="button"
              className="vault-cta"
              disabled={connected && !canSubmit}
              data-testid={`${mode}-submit`}
              onClick={connected ? submit : onConnect}
            >
              {ctaText}
            </button>

            <div className="vault-notes">
              {mode === "deposit" && paused ? (
                <span className="vault-note">
                  Pool is paused: deposits are blocked; withdrawals stay live.
                </span>
              ) : null}
              {mode === "withdraw" ? (
                <span className="vault-note" data-testid="withdraw-lock-note">
                  Principal and Tickets leave your account now. The USDC pays
                  out once today's draw is over.
                </span>
              ) : null}
              {overCap ? (
                <span className="vault-note" data-testid={`${mode}-over-balance`}>
                  {mode === "deposit"
                    ? "Amount is more than your wallet balance."
                    : "Amount is more than your Principal."}
                </span>
              ) : null}
              {mode === "deposit" && pool ? (
                <span className="vault-note">
                  Minimum deposit {fmt2(pool.minDeposit)} {SYMBOL}.
                </span>
              ) : null}
              {note ? (
                <span className={`vault-note ${note.tone}`} data-testid="vault-note">
                  {note.text}
                </span>
              ) : null}
            </div>
          </div>
        </section>
        <GlyphRow />
      </div>
      {confirmed !== null ? (
        <DepositConfirmed
          amount={`$${fmt2(confirmed)} ${SYMBOL}`}
          tickets={fmt2(entries)}
          onClose={() => setConfirmed(null)}
          onPlay={onPlay}
        />
      ) : null}
    </div>
  );
}

interface DepositConfirmedProps {
  amount: string;
  /** Live Tickets balance; refreshes in place once the chain read lands. */
  tickets: string;
  onClose: () => void;
  onPlay: () => void;
}

/** The Figma "deposit confirmed" popup: backdrop, ×, and Escape dismiss. */
function DepositConfirmed({ amount, tickets, onClose, onPlay }: DepositConfirmedProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="deposit-modal-backdrop" onClick={onClose} data-testid="deposit-modal">
      <section
        className="deposit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="deposit-modal-head">
          <span className="deposit-modal-brand">
            <LogoCog size={18} />
            DEPOSIT
          </span>
          <button
            ref={closeRef}
            type="button"
            className="deposit-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <img
          className="deposit-modal-coin"
          src="/deposit-check.png"
          alt=""
          width={188}
          height={188}
        />
        <p className="deposit-modal-kicker">DEPOSIT CONFIRMED</p>
        <p className="deposit-modal-amount" id="deposit-modal-title" data-testid="deposit-modal-amount">
          {amount}
        </p>
        <p className="deposit-modal-sub">
          You have <strong>{tickets} Tickets</strong> to play
        </p>
        <button
          type="button"
          className="vault-cta deposit-modal-play"
          data-testid="deposit-modal-play"
          onClick={onPlay}
        >
          Play HEXO
        </button>
      </section>
    </div>
  );
}
