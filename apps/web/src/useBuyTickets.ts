/**
 * Owns the Buy Tickets widget's state (ticket 10): the amount input, the
 * derived tickets/draw-value/disabled-reason, and send-and-confirm. The
 * markup only reads what this returns, mirroring useAccessGate.ts.
 */
import { useCallback, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { buyTickets, type TxSigner } from "./actions.js";
import { buyDisabledReason, drawValue, ticketsFromUsdc } from "./buyTickets.js";
import type { HexVaultProgram } from "./chain.js";
import { parseAtomic } from "./lib/money.js";
import type { PoolLike } from "./read.js";

const DECIMALS = 6;

export interface UseBuyTicketsOptions {
  program: HexVaultProgram | null;
  owner: PublicKey | null;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  paused: boolean;
  principal: bigint;
  /** Null until `GET /players/:owner` has answered once. */
  allowanceLeft: bigint | null;
  /** Seconds left in today's draw, for the draw-value preview. */
  secondsLeft: bigint;
  epochSeconds: bigint;
  onDone: () => void;
}

export interface BuyTicketsState {
  amountText: string;
  setAmountText: (text: string) => void;
  amount: bigint | null;
  tickets: bigint;
  drawValueTickets: bigint;
  allowanceLeft: bigint | null;
  /** Reason the button is disabled, or null when it can be pressed. */
  disabledReason: string | null;
  busy: boolean;
  error: string | null;
  canSubmit: boolean;
  submit: () => void;
}

export function useBuyTickets(options: UseBuyTicketsOptions): BuyTicketsState {
  const {
    program,
    owner,
    sendTransaction,
    pool,
    paused,
    principal,
    allowanceLeft,
    secondsLeft,
    epochSeconds,
    onDone,
  } = options;
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = parseAtomic(amountText, DECIMALS);
  const tickets = amount !== null ? ticketsFromUsdc(amount, pool?.ticketsPerUsdc ?? 0) : 0n;
  const drawValueTickets = drawValue(tickets, secondsLeft, epochSeconds);

  // `allowanceLeft` lags behind `principal`/`paused` (its own slower poll), so
  // "loading…" only shows for a depositor who is genuinely waiting on it.
  // Paused and zero-Principal are already known from the fast state poll, and
  // short-circuit inside buyDisabledReason before its allowance check runs.
  const disabledReason =
    owner === null
      ? "connect a wallet"
      : paused || principal <= 0n || allowanceLeft !== null
        ? buyDisabledReason({ paused, principal, allowanceLeft: allowanceLeft ?? 0n })
        : "loading…";

  const canSubmit =
    !busy &&
    disabledReason === null &&
    amount !== null &&
    amount > 0n &&
    allowanceLeft !== null &&
    amount <= allowanceLeft &&
    program !== null &&
    owner !== null &&
    pool !== null;

  const submit = useCallback(() => {
    if (!canSubmit || !program || !owner || !pool || amount === null) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await buyTickets(program, { publicKey: owner, sendTransaction }, pool, amount);
        setAmountText("");
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [canSubmit, program, owner, pool, sendTransaction, amount, onDone]);

  return {
    amountText,
    setAmountText,
    amount,
    tickets,
    drawValueTickets,
    allowanceLeft,
    disabledReason,
    busy,
    error,
    canSubmit,
    submit,
  };
}
