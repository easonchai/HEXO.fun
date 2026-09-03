/**
 * VAULT tab — custody surface: deposit accepted asset, withdraw matched
 * principal, refresh entries after a rollover, and inspect receipts. The
 * program is the custody boundary: PT and ET always move together.
 */
import { useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { deposit, refreshEntries, withdraw } from "../actions.js";
import type { HexVaultProgram } from "../chain.js";
import {
  formatAtomic,
  parseAtomic,
  previewWithdraw,
  withdrawable,
} from "../lib/money.js";
import { epochAddress } from "../chain.js";
import type { EpochRow, PoolLike } from "../read.js";
import type { Balances, PlayerRow } from "../state.js";
import { PanelCard } from "../ui.js";

export interface VaultScreenProps {
  program: HexVaultProgram;
  owner: PublicKey;
  pool: PoolLike;
  latestEpoch: EpochRow | null;
  balances: Balances;
  player: PlayerRow | null;
  paused: boolean;
  onDone: () => void;
}

export function Vault(props: VaultScreenProps) {
  const {
    program,
    owner,
    pool,
    latestEpoch,
    balances,
    player,
    paused,
    onDone,
  } = props;
  const decimals = pool.acceptedDecimals;
  const fmt = (value: bigint) => formatAtomic(value, decimals);
  const epochKey = latestEpoch
    ? epochAddress(pool.address, latestEpoch.id)
    : null;

  const [amountText, setAmountText] = useState("");
  const [withdrawText, setWithdrawText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const needsRefresh =
    player !== null &&
    latestEpoch !== null &&
    player.lastEntryEpochId !== latestEpoch.id;

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

  const depositAmount = parseAtomic(amountText, decimals);
  const withdrawAmount = parseAtomic(withdrawText, decimals);
  const matched = withdrawable(balances.principal, balances.entries);
  const withdrawalPreview =
    withdrawAmount === null
      ? null
      : previewWithdraw(balances.principal, balances.entries, withdrawAmount);

  return (
    <div className="screen-vault" data-testid="vault-screen">
      <PanelCard
        wide
        title="DEPOSIT"
        aside={
          <span className="dual-line-inline">
            wallet {pool.acceptedMint.toBase58().slice(0, 4)}…{" "}
            {fmt(balances.accepted)}
          </span>
        }
      >
        <p className="screen-copy">
          Deposit mints equal PT and ET 1:1. ET is the entry currency for
          rounds; PT stays matched to principal.
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
                      BigInt(units) * 10n ** BigInt(decimals),
                      decimals,
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
              onClick={() => setAmountText(fmt(balances.accepted))}
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
              depositAmount <= 0n ||
              !epochKey ||
              needsRefresh
            }
            data-testid="deposit-submit"
            onClick={() =>
              void run("Deposit", () =>
                deposit(
                  program,
                  { publicKey: owner },
                  pool,
                  epochKey!,
                  depositAmount!,
                ),
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
          {needsRefresh ? (
            <div className="panel-note" data-testid="needs-refresh">
              New epoch: refresh entries to restore matched withdrawals and
              deposits.
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="btn-deploy ghost"
          disabled={busy !== null || !needsRefresh || !epochKey}
          data-testid="refresh-entries"
          onClick={() =>
            void run("Refresh", () =>
              refreshEntries(program, { publicKey: owner }, pool, epochKey!),
            )
          }
        >
          <span>{busy === "Refresh" ? "SIGNING…" : "REFRESH ENTRIES"}</span>
        </button>
      </PanelCard>

      <PanelCard
        wide
        title="WITHDRAW"
        aside={<span className="dual-line-inline">matched {fmt(matched)}</span>}
      >
        <p className="screen-copy">
          A withdrawal burns equal PT and ET and pays out principal. You can
          withdraw exactly your matched balance — spent ET lowers it until the
          next refresh.
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
              MATCHED MAX
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
                before PT {fmt(balances.principal)} / ET {fmt(balances.entries)}{" "}
                / withdrawable {fmt(withdrawalPreview.withdrawableBefore)}
              </span>
              <span className="dual-accent">
                after PT {fmt(withdrawalPreview.principalAfter)} / ET{" "}
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
