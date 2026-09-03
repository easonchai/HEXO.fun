/**
 * PRIZES tab — epoch prize + jackpot status and self-serve claims. Winner
 * proofs are built in-browser from the indexer's snapshot cache (root +
 * player weights), then verified on-chain at claim time.
 */
import { useCallback, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { claimJackpot, claimPrize, requestEpochDraw } from "../actions.js";
import { apiBaseUrl, fetchSnapshot } from "../api.js";
import { epochAddress, type HexVaultProgram } from "../chain.js";
import { formatAtomic } from "../lib/money.js";
import {
  claimProofFromSnapshot,
  type ClaimProof,
  type SnapshotPayload,
} from "../lib/snapshotProof.js";
import { labelEpochStatus, labelJackpotStatus } from "../lib/protocol.js";
import type { EpochRow, PoolLike, RandomnessRow } from "../read.js";
import type { VaultBalances } from "../state.js";
import type { Takeover } from "../useRoundEngine.js";

const ENV: Record<string, string | undefined> = {
  VITE_API_URL: import.meta.env.VITE_API_URL as string | undefined,
};

export interface PrizesProps {
  program: HexVaultProgram;
  owner: PublicKey;
  pool: PoolLike;
  epochs: EpochRow[];
  epochRandomness: Map<string, RandomnessRow>;
  vaults: VaultBalances;
  onDone: () => void;
  /** Fires the full-screen win takeover (e.g. "HEXPOT HIT"). */
  onWon: (takeover: Takeover) => void;
}

export function Prizes(props: PrizesProps) {
  const {
    program,
    owner,
    pool,
    epochs,
    epochRandomness,
    vaults,
    onDone,
    onWon,
  } = props;
  const decimals = pool.acceptedDecimals;
  const fmt = (value: bigint) => formatAtomic(value, decimals);
  const baseUrl = apiBaseUrl(ENV);
  const [epochIdText, setEpochIdText] = useState("");
  const epoch =
    epochs.find((candidate) => candidate.id.toString() === epochIdText) ??
    epochs[epochs.length - 1] ??
    null;

  const [proofs, setProofs] = useState<{
    prize: ClaimProof | null;
    jackpot: ClaimProof | null;
  }>({ prize: null, jackpot: null });
  const [proofNote, setProofNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const prizeRequest = epoch
    ? epochRandomness.get(`prize:${epoch.id.toString()}`)
    : undefined;
  const jackpotRequest = epoch
    ? epochRandomness.get(`jackpot:${epoch.id.toString()}`)
    : undefined;

  const loadProofs = useCallback(async () => {
    if (!epoch) return;
    const snapshot = await fetchSnapshot(
      baseUrl,
      pool.address.toBase58(),
      epoch.id,
    );
    if (!snapshot.ok) {
      setProofNote(
        `indexer offline (${snapshot.reason}) — claims need it for proofs`,
      );
      setProofs({ prize: null, jackpot: null });
      return;
    }
    const body = (snapshot.data as { snapshot: SnapshotPayload | null })
      .snapshot;
    if (!body) {
      setProofNote("no snapshot committed for this epoch yet");
      setProofs({ prize: null, jackpot: null });
      return;
    }
    try {
      const prizeTarget = epoch.status >= 3 ? epoch.prizeTarget : null;
      const jackpotTarget =
        epoch.jackpotStatus >= 2 ? epoch.jackpotTarget : null;
      const prize = claimProofFromSnapshot(body, owner, prizeTarget);
      const jackpot = claimProofFromSnapshot(body, owner, jackpotTarget);
      setProofs({ prize, jackpot });
      setProofNote(
        `your weight ${prize.weight} of ${prize.totalWeight} — interval starts at ${prize.prefix}`,
      );
    } catch (error) {
      setProofs({ prize: null, jackpot: null });
      setProofNote(error instanceof Error ? error.message : String(error));
    }
  }, [epoch, owner, pool.address, baseUrl]);

  useEffect(() => {
    void loadProofs();
  }, [loadProofs]);

  const submit = async (kind: "prize" | "jackpot") => {
    if (!epoch) return;
    const proof = proofs[kind];
    if (!proof) return;
    setBusy(kind);
    setNote(null);
    try {
      const epochKey = epochAddress(pool.address, epoch.id);
      const signature =
        kind === "prize"
          ? await claimPrize(
              program,
              { publicKey: owner },
              pool,
              epochKey,
              proof.weight,
              proof.proof,
            )
          : await claimJackpot(
              program,
              { publicKey: owner },
              pool,
              epochKey,
              proof.weight,
              proof.proof,
            );
      const amount = kind === "prize" ? epoch.prizeAmount : epoch.jackpotAmount;
      onWon({
        title: kind === "prize" ? "PRIZE CLAIMED" : "HEXPOT HIT",
        amount: `+${formatAtomic(amount, decimals)}`,
        tileText: `Epoch ${epoch.id}`,
      });
      setNote({
        tone: "ok",
        text: `${kind} claimed: ${signature.slice(0, 16)}…`,
      });
      onDone();
    } catch (error) {
      setNote({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const requestDraw = async (kind: "prize" | "jackpot") => {
    if (!epoch) return;
    setBusy(`${kind}-draw`);
    setNote(null);
    try {
      await requestEpochDraw(
        program,
        { publicKey: owner },
        pool,
        epochAddress(pool.address, epoch.id),
        kind === "prize" ? 1 : 2,
      );
      setNote({ tone: "ok", text: `${kind} draw requested` });
      onDone();
    } catch (error) {
      setNote({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen-vault" data-testid="prizes-screen">
      <div className="panel-card wide">
        <div className="panel-head">
          <span className="panel-title">EPOCH</span>
          <select
            value={epoch?.id.toString() ?? ""}
            onChange={(event) => setEpochIdText(event.target.value)}
            data-testid="prize-epoch-select"
            className="epoch-select"
          >
            {epochs.map((candidate) => (
              <option
                key={candidate.id.toString()}
                value={candidate.id.toString()}
              >
                epoch #{candidate.id.toString()} —{" "}
                {labelEpochStatus(candidate.status)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel-card wide">
        <div className="panel-head">
          <span className="panel-title">EPOCH PRIZE</span>
          <span className="dual-line-inline">
            {labelEpochStatus(epoch?.status ?? 0)}
          </span>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-label">Amount</span>
            <span className="stat-value" data-testid="prize-amount">
              {fmt(epoch?.prizeAmount ?? 0n)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Total weight</span>
            <span className="stat-value" data-testid="prize-total-weight">
              {epoch?.totalEntryWeight.toString() ?? "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Draw target</span>
            <span className="stat-value">
              {epoch ? epoch.prizeTarget.toString() : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Draw</span>
            <span className="stat-value" data-testid="prize-draw-status">
              {prizeRequest
                ? prizeRequest.status === 1
                  ? "fulfilled"
                  : "pending"
                : "not requested"}
            </span>
          </div>
        </div>
        {epoch && epoch.status === 1 ? (
          <button
            type="button"
            className="btn-deploy ghost"
            disabled={busy !== null}
            data-testid="prize-request-draw"
            onClick={() => void requestDraw("prize")}
          >
            <span>REQUEST PRIZE DRAW (PERMISSIONLESS)</span>
          </button>
        ) : null}
        {proofs.prize?.isWinner ? (
          <button
            type="button"
            className="btn-deploy"
            disabled={busy !== null || epoch?.status !== 3}
            data-testid="prize-claim"
            onClick={() => void submit("prize")}
          >
            <span>
              {busy === "prize"
                ? "SIGNING…"
                : `CLAIM PRIZE ${fmt(epoch?.prizeAmount ?? 0n)}`}
            </span>
          </button>
        ) : null}
      </div>

      <div className="panel-card wide">
        <div className="panel-head">
          <span className="panel-title">HEXPOT JACKPOT</span>
          <span className="dual-line-inline">
            {labelJackpotStatus(epoch?.jackpotStatus ?? 0)}
          </span>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-label">Vault</span>
            <span className="stat-value" data-testid="jackpot-vault">
              {fmt(vaults.jackpotVault)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Committed</span>
            <span className="stat-value" data-testid="jackpot-amount">
              {fmt(epoch?.jackpotAmount ?? 0n)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Draw target</span>
            <span className="stat-value">
              {epoch ? epoch.jackpotTarget.toString() : "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Draw</span>
            <span className="stat-value" data-testid="jackpot-draw-status">
              {jackpotRequest
                ? jackpotRequest.status === 1
                  ? "fulfilled"
                  : "pending"
                : "not requested"}
            </span>
          </div>
        </div>
        {epoch && epoch.jackpotStatus === 1 ? (
          <button
            type="button"
            className="btn-deploy ghost"
            disabled={busy !== null}
            data-testid="jackpot-request-draw"
            onClick={() => void requestDraw("jackpot")}
          >
            <span>REQUEST JACKPOT DRAW (PERMISSIONLESS)</span>
          </button>
        ) : null}
        {proofs.jackpot?.isWinner ? (
          <button
            type="button"
            className="btn-deploy"
            disabled={busy !== null || epoch?.jackpotStatus !== 2}
            data-testid="jackpot-claim"
            onClick={() => void submit("jackpot")}
          >
            <span>
              {busy === "jackpot"
                ? "SIGNING…"
                : `CLAIM JACKPOT ${fmt(epoch?.jackpotAmount ?? 0n)}`}
            </span>
          </button>
        ) : null}
      </div>

      {proofNote ? (
        <div className="panel-note" data-testid="proof-note">
          {proofNote}
        </div>
      ) : null}
      {note ? (
        <div className={`screen-note ${note.tone}`} data-testid="prize-note">
          {note.text}
        </div>
      ) : null}
    </div>
  );
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
