/**
 * VAULT tab — custody: deposit hexUSDC, withdraw matched principal, and pull
 * test hexUSDC from the faucet. The program is the custody boundary:
 * Principal and Entries move together, so a withdrawal needs both.
 */
import { useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { deposit, withdraw } from "../actions.js";
import { apiBaseUrl, requestFaucet } from "../api.js";
import type { HexVaultProgram } from "../chain.js";
import {
  formatAtomic,
  parseAtomic,
  previewWithdraw,
  withdrawable,
} from "../lib/money.js";
import type { PoolLike } from "../read.js";
import { PanelCard } from "../ui.js";

const DECIMALS = 6;
const SYMBOL = "hexUSDC";

export interface VaultScreenProps {
  program: HexVaultProgram;
  owner: PublicKey;
  pool: PoolLike;
  principal: bigint;
  entries: bigint;
  walletBalance: bigint;
  paused: boolean;
  onDone: () => void;
}

export function Vault(props: VaultScreenProps) {
  const {
    program,
    owner,
    pool,
    principal,
    entries,
    walletBalance,
    paused,
    onDone,
  } = props;
  const fmt = (value: bigint) => formatAtomic(value, DECIMALS);

  const [amountText, setAmountText] = useState("");
  const [withdrawText, setWithdrawText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );
  /** Seconds the faucet says to wait; ticket 11 turns this into a countdown. */
  const [faucetWait, setFaucetWait] = useState<number | null>(null);

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label);
    setNote(null);
    try {
      const signature = await action();
      setNote({
        tone: "ok",
        text: `${label} confirmed: ${signature.slice(0, 16)}…`,
      });
      onDone();
    } catch (error) {
      setNote({
        tone: "err",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const pullFaucet = async () => {
    setBusy("Faucet");
    setNote(null);
    setFaucetWait(null);
    const result = await requestFaucet(apiBaseUrl(), owner.toBase58());
    if (result.ok) {
      setNote({
        tone: "ok",
        text: `faucet sent ${fmt(BigInt(result.data.amount))} ${SYMBOL}`,
      });
      onDone();
    } else if ("retryAfterSeconds" in result) {
      setFaucetWait(result.retryAfterSeconds);
      setNote({
        tone: "err",
        text: `faucet rate limited: try again in ${result.retryAfterSeconds}s`,
      });
    } else {
      setNote({ tone: "err", text: result.reason });
    }
    setBusy(null);
  };

  const depositAmount = parseAtomic(amountText, DECIMALS);
  const withdrawAmount = parseAtomic(withdrawText, DECIMALS);
  const matched = withdrawable(principal, entries);
  const withdrawalPreview =
    withdrawAmount === null
      ? null
      : previewWithdraw(principal, entries, withdrawAmount);

  return (
    <div className="screen-vault" data-testid="vault-screen">
      <PanelCard
        wide
        title="DEPOSIT"
        aside={
          <span className="dual-line-inline">
            wallet {SYMBOL} {fmt(walletBalance)}
          </span>
        }
      >
        <p className="screen-copy">
          A deposit credits equal Principal and Entries. Entries pay for
          positions on the board and decide your odds in the draw; Principal is
          never at risk.
        </p>
        <div className="vault-form">
          <div className="volt-banner slim">
            <input
              value={amountText}
              placeholder="0.00"
              onChange={(event) =>
                setAmountText(event.target.value.replace(/[^0-9.]/g, ""))
              }
              inputMode="decimal"
              data-testid="deposit-input"
              aria-label="Deposit amount"
            />
          </div>
          <div className="quick-row">
            {[1, 5, 10].map((units) => (
              <span
                key={units}
                className="pill"
                role="button"
                onClick={() =>
                  setAmountText(
                    formatAtomic(
                      BigInt(units) * 10n ** BigInt(DECIMALS),
                      DECIMALS,
                    ),
                  )
                }
              >
                +{units}
              </span>
            ))}
            <span
              className="pill max"
              role="button"
              onClick={() => setAmountText(fmt(walletBalance))}
            >
              MAX
            </span>
          </div>
          <button
            type="button"
            className="btn-deploy"
            disabled={
              busy !== null ||
              paused ||
              !depositAmount ||
              depositAmount < pool.minDeposit
            }
            data-testid="deposit-submit"
            onClick={() =>
              void run("Deposit", () =>
                deposit(program, { publicKey: owner }, pool, depositAmount!),
              )
            }
          >
            <span>
              {busy === "Deposit"
                ? "SIGNING…"
                : paused
                  ? "POOL PAUSED"
                  : "DEPOSIT"}
            </span>
          </button>
          {paused ? (
            <div className="panel-note">
              Pool is paused: deposits are blocked; withdrawals stay live.
            </div>
          ) : null}
          <div className="panel-note">
            Minimum deposit {fmt(pool.minDeposit)} {SYMBOL}.
          </div>
        </div>
        <button
          type="button"
          className="btn-deploy ghost"
          disabled={busy !== null}
          data-testid="faucet"
          onClick={() => void pullFaucet()}
        >
          <span>
            {busy === "Faucet"
              ? "REQUESTING…"
              : faucetWait !== null
                ? `FAUCET IN ${faucetWait}s`
                : `GET TEST ${SYMBOL}`}
          </span>
        </button>
      </PanelCard>

      <PanelCard
        wide
        title="WITHDRAW"
        aside={
          <span className="dual-line-inline">withdrawable {fmt(matched)}</span>
        }
      >
        <p className="screen-copy">
          A withdrawal takes the same amount off Principal and Entries and pays
          out {SYMBOL}. You can withdraw min(Principal, Entries) — Entries
          staked in an open round lower it until that round settles.
        </p>
        <div className="vault-form">
          <div className="volt-banner slim">
            <input
              value={withdrawText}
              placeholder="0.00"
              onChange={(event) =>
                setWithdrawText(event.target.value.replace(/[^0-9.]/g, ""))
              }
              inputMode="decimal"
              data-testid="withdraw-input"
              aria-label="Withdraw amount"
            />
          </div>
          <div className="quick-row">
            <span
              className="pill"
              role="button"
              onClick={() => setWithdrawText(fmt(matched))}
            >
              MAX
            </span>
            <span
              className="pill"
              role="button"
              onClick={() => setWithdrawText("")}
            >
              CLEAR
            </span>
          </div>
          {withdrawalPreview ? (
            <div className="dual-line" data-testid="withdraw-preview">
              <span>
                before Principal {fmt(principal)} / Entries {fmt(entries)} /
                withdrawable {fmt(withdrawalPreview.withdrawableBefore)}
              </span>
              <span className="dual-accent">
                after Principal {fmt(withdrawalPreview.principalAfter)} / Entries{" "}
                {fmt(withdrawalPreview.entriesAfter)} / withdrawable{" "}
                {fmt(withdrawalPreview.withdrawableAfter)}
              </span>
            </div>
          ) : null}
          <button
            type="button"
            className="btn-deploy ghost"
            disabled={
              busy !== null ||
              !withdrawAmount ||
              withdrawAmount <= 0n ||
              withdrawAmount > matched
            }
            data-testid="withdraw-submit"
            onClick={() =>
              void run("Withdraw", () =>
                withdraw(program, { publicKey: owner }, pool, withdrawAmount!),
              )
            }
          >
            <span>{busy === "Withdraw" ? "SIGNING…" : "WITHDRAW"}</span>
          </button>
        </div>
      </PanelCard>

      {note ? (
        <div className={`screen-note ${note.tone}`} data-testid="vault-note">
          {note.text}
        </div>
      ) : null}
    </div>
  );
}
