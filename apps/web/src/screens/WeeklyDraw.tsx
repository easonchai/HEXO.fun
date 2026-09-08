/**
 * WEEKLY DRAW tab: the epoch's simulated yield as this week's prize, on the
 * tab ticket 10 emptied out when it deleted the old EXPLORE screen. Everything
 * here is aggregate state from the API (epoch, prize amount, your weight and
 * odds, past winners). `register` is the one on-chain write it sends, and
 * only as the permissionless fallback PRD §3.3 describes.
 *
 * "Epoch" stays the mechanism name in code and the API; on screen it is a
 * week (ticket 14).
 */
import { useCallback, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { atomicShort } from "../activityRows.js";
import { register, type TxSigner } from "../actions.js";
import {
  apiBaseUrl,
  fetchCurrentEpoch,
  fetchEpochs,
  fetchPlayer,
  type EpochDto,
} from "../api.js";
import type { HexVaultProgram } from "../chain.js";
import { hmText } from "../engine.js";
import { formatAddress } from "../lib/money.js";
import type { PoolLike } from "../read.js";
import { PanelCard, Stat, StatGrid } from "../ui.js";
import { useApiPoll } from "../useApiPoll.js";

const SYMBOL = "USDC";
/** Rollovers leave `winner: null`, so look back further than 5 to find five. */
const EPOCH_LOOKBACK = 20;
const WINNERS_SHOWN = 5;

export interface WeeklyDrawScreenProps {
  program: HexVaultProgram | null;
  owner: PublicKey | undefined;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  onDone: () => void;
}

export function WeeklyDraw(props: WeeklyDrawScreenProps) {
  const { program, owner, sendTransaction, pool, now, onDone } = props;
  const ownerBase58 = owner?.toBase58();

  const loadCurrentEpoch = useCallback(
    (signal: AbortSignal) => fetchCurrentEpoch(apiBaseUrl(), signal),
    [],
  );
  const loadEpochs = useCallback(
    (signal: AbortSignal) => fetchEpochs(apiBaseUrl(), EPOCH_LOOKBACK, signal),
    [],
  );
  const loadPlayer = useCallback(
    (signal: AbortSignal) =>
      ownerBase58
        ? fetchPlayer(apiBaseUrl(), ownerBase58, signal)
        : Promise.resolve({ ok: false as const, reason: "no wallet connected" }),
    [ownerBase58],
  );

  const epoch = useApiPoll(loadCurrentEpoch, 2000);
  const history = useApiPoll(loadEpochs, 2000);
  const player = useApiPoll(loadPlayer, 2000);

  const winners = useMemo(
    () =>
      (history.data ?? [])
        .filter((row): row is EpochDto & { winner: string } => row.winner !== null)
        .slice(0, WINNERS_SHOWN),
    [history.data],
  );

  const countdown =
    epoch.data && now !== null
      ? hmText(BigInt(epoch.data.endsAt) - now)
      : "--:--";
  const drawing = epoch.data?.drawing ?? null;

  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerNote, setRegisterNote] = useState<string | null>(null);
  const registerMe = useCallback(async () => {
    if (!drawing || !program || !pool || !owner) return;
    setRegisterBusy(true);
    setRegisterNote(null);
    try {
      await register(
        program,
        { publicKey: owner, sendTransaction },
        pool,
        BigInt(drawing.epochId),
      );
      setRegisterNote("registered your weight for this draw");
      onDone();
    } catch (error) {
      setRegisterNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRegisterBusy(false);
    }
  }, [drawing, program, pool, owner, sendTransaction, onDone]);

  const apiError = epoch.error ?? player.error ?? history.error;

  return (
    <div className="screen-vault" data-testid="weekly-draw-screen">
      <PanelCard
        wide
        title="WEEKLY DRAW"
        aside={
          <span className="dual-line-inline">draw in {countdown}</span>
        }
      >
        <p className="screen-copy">
          This week's prize is the pool's yield, simulated at a published 5%
          APR and labeled as such everywhere it appears. The weekly draw pays
          it in full to one winner; your odds are your share of the week's
          Weight so far.
        </p>
        <StatGrid>
          <Stat
            label="Prize (simulated 5% APR)"
            value={
              epoch.data ? `${atomicShort(epoch.data.jackpotAmount)} ${SYMBOL}` : "—"
            }
            testid="prize-amount"
          />
          <Stat
            label="Your weight"
            value={
              player.data
                ? atomicShort(player.data.liveWeight)
                : ownerBase58
                  ? "—"
                  : "connect a wallet"
            }
            testid="your-weight"
          />
          <Stat
            label="Your odds"
            value={player.data ? `${player.data.odds}%` : "—"}
            testid="your-odds"
          />
          <Stat label="Week" value={epoch.data ? `#${epoch.data.id}` : "—"} small />
        </StatGrid>
      </PanelCard>

      {drawing ? (
        <PanelCard wide title={`DRAWING WEEK ${drawing.epochId}`}>
          <p className="screen-copy">
            registered {drawing.registeredCount} of {drawing.eligible} eligible
            players
          </p>
          <button
            type="button"
            className="btn-deploy ghost"
            disabled={registerBusy || !program || !pool || !owner}
            data-testid="register-me"
            title={!owner ? "connect a wallet to register" : undefined}
            onClick={() => void registerMe()}
          >
            <span>{registerBusy ? "SIGNING…" : "REGISTER ME"}</span>
          </button>
          {registerNote ? (
            <div className="panel-note" data-testid="register-note">
              {registerNote}
            </div>
          ) : null}
        </PanelCard>
      ) : null}

      <PanelCard wide title="LAST WINNERS">
        {winners.length === 0 ? (
          <p className="screen-copy">no weekly draw has paid a winner yet.</p>
        ) : (
          <div className="board-list" data-testid="winner-rows">
            {winners.map((row) => (
              <div className="board-row" key={row.id}>
                <span>week #{row.id}</span>
                <span>
                  {row.winner === ownerBase58 ? "you" : formatAddress(row.winner)}
                </span>
                <span>
                  {atomicShort(row.jackpotAmount)} {SYMBOL}
                </span>
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      {apiError ? <div className="screen-note err">{apiError}</div> : null}
    </div>
  );
}
