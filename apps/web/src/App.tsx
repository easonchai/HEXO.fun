/** MINE screen wiring: header, arena + control panel, tabs, live events. */
import { AnchorProvider, Program } from "@anchor-lang/core";
import { useConnection } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Arena, LogoCog } from "./arena/Arena.js";
import { ControlPanel } from "./panel/ControlPanel.js";
import { About } from "./screens/About.js";
import { Prizes } from "./screens/Prizes.js";
import { Vault } from "./screens/Vault.js";
import {
  buyPosition,
  claimRoundReward,
  deposit,
  requestRoundRandomness,
} from "./actions.js";
import { apiBaseUrl, fetchEvents, type EventRow } from "./api.js";
import { epochAddress, type HexVaultProgram } from "./chain.js";
import { idl } from "./idl.js";
import {
  covers,
  currentRound,
  displayTile,
  expectedReward,
  phaseFor,
  roundKey,
  ROUND_OPEN,
  type FeedRow,
} from "./engine.js";
import { formatAddress, formatAtomic, parseAtomic } from "./lib/money.js";
import { sfx, setSoundOn, subscribeSound, isSoundOn } from "./sfx.js";
import { useVaultState, type VaultState } from "./state.js";
import { useChainClock } from "./useChainClock.js";
import { useProgramEvents, type LiveEvent } from "./useProgramEvents.js";
import { useRoundEngine, type Takeover } from "./useRoundEngine.js";
import { anchorWalletOf, useGameSigner } from "./wallets.js";
import { clusterFromEnv, type Cluster } from "./wallet.js";

const TABS = ["MINE", "VAULT", "PRIZES", "ABOUT"] as const;
type Tab = (typeof TABS)[number];

const ENV: Record<string, string | undefined> = {
  VITE_CLUSTER: import.meta.env.VITE_CLUSTER as string | undefined,
  VITE_API_URL: import.meta.env.VITE_API_URL as string | undefined,
  VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID as string | undefined,
};

const symbolOf = (pool: VaultState["pool"]): string => "USDC";

export function App() {
  const { connection } = useConnection();
  const signer = useGameSigner();
  const { publicKey, connected } = signer;
  const [tab, setTab] = useState<Tab>("MINE");
  const [soundOn, setSoundOnState] = useState(isSoundOn());
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [stakeText, setStakeText] = useState("0.01");
  const [autoRounds, setAutoRounds] = useState(0);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [vaultNote, setVaultNote] = useState<string | null>(null);
  const [claimTakeover, setClaimTakeover] = useState<Takeover | null>(null);
  const [feedHistory, setFeedHistory] = useState<FeedRow[]>([]);

  const cluster: Cluster = clusterFromEnv(ENV);
  const poolId = null; // auto-discover; multiple pools arrive later.

  const anchorWallet = useMemo(() => anchorWalletOf(signer), [signer]);
  const provider = useMemo(() => {
    const walletArg = anchorWallet ?? ({ publicKey: undefined } as never);
    return new AnchorProvider(connection, walletArg as never, {
      commitment: "confirmed",
    });
  }, [connection, anchorWallet]);
  const program = useMemo<HexVaultProgram | null>(
    () =>
      provider
        ? (new Program(idl, provider) as unknown as HexVaultProgram)
        : null,
    [provider],
  );

  const state = useVaultState(
    connection,
    program,
    publicKey ?? undefined,
    poolId,
  );
  const pool = state.pool;
  const { now } = useChainClock(connection);
  const { events, live } = useProgramEvents(program);
  const engine = useRoundEngine({
    rounds: state.rounds,
    positions: state.positions,
    owner: publicKey ?? undefined,
    poolBufferSeconds: pool?.roundCloseBufferSeconds ?? 0n,
    hexpot: state.vaults.jackpotVault,
    clockNow: now,
    feed: [],
  });

  const refresh = state.refresh;

  // Poll fallback + resync after each live event (WS push is primary).
  useEffect(() => {
    const id = window.setInterval(() => refresh(), 4000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const eventCount = events.length;
  useEffect(() => {
    if (eventCount === 0) return;
    const id = window.setTimeout(() => refresh(), 250);
    return () => window.clearTimeout(id);
  }, [eventCount, refresh]);

  // Feed: /events history first, then live events on top.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await fetchEvents(apiBaseUrl(ENV), 12, controller.signal);
      if (result.ok)
        setFeedHistory(eventsToRows(result.data, publicKey?.toBase58()));
    })();
    return () => controller.abort();
  }, [publicKey]);

  const ownerKey = publicKey?.toBase58();
  const liveFeed = useMemo<FeedRow[]>(() => {
    const rows: FeedRow[] = [];
    for (const event of events) {
      const row = liveEventToRow(event, ownerKey);
      if (row) rows.push(row);
    }
    return rows;
  }, [events, ownerKey]);
  const feed = useMemo(
    () => mergeFeed(liveFeed, feedHistory, ownerKey),
    [liveFeed, feedHistory, ownerKey],
  );

  const latestEpoch = state.epochs.at(-1) ?? null;
  const latestEpochKey =
    pool && latestEpoch ? epochAddress(pool.address, latestEpoch.id) : null;
  const active = currentRound(state.rounds);

  // --- Actions ---------------------------------------------------------------
  const decimals = pool?.acceptedDecimals ?? 6;
  const fmt = (value: bigint) => formatAtomic(value, decimals);
  const stake = parseAtomic(stakeText, decimals) ?? 0n;
  const mask = useMemo(
    () =>
      engine.selected.reduce((acc, tile) => acc | (1n << BigInt(tile - 1)), 0n),
    [engine.selected],
  );
  const position = engine.activePosition;
  const locked = Boolean(position);
  const deployedTotal = position
    ? BigInt(position.tiles.toString(2).replace(/[^1]/g, "").length) *
      position.stakePerTile
    : 0n;

  const problems: string[] = [];
  if (!pool) problems.push("no pool discovered yet");
  if (!active) problems.push("no active round (operator creates rounds)");
  if (
    active &&
    phaseFor(active, now ?? 0n, pool?.roundCloseBufferSeconds ?? 0n) !== "mine"
  )
    problems.push("buying is closed for this round");
  if (locked && active)
    problems.push(`position already deployed on round #${active.id}`);
  if (stake > (pool?.maxStakePerTile ?? 0n))
    problems.push(`stake above pool max ${fmt(pool?.maxStakePerTile ?? 0n)}`);
  if (
    stake * BigInt(Math.max(engine.selected.length, 1)) >
    state.balances.entries
  )
    problems.push("not enough ET — deposit to mint more entries");

  const deploy = useCallback(async () => {
    if (!pool || !active || !publicKey || !program) return;
    if (engine.selected.length === 0 || stake <= 0n) return;
    setDeployBusy(true);
    setDeployNote(null);
    try {
      sfx("click");
      const signature = await buyPosition(
        program,
        { publicKey },
        pool,
        epochAddress(pool.address, active.epochId),
        active.epochId,
        active.id,
        mask,
        stake,
      );
      setDeployNote(
        `deployed ${fmt(stake * BigInt(engine.selected.length))} ET on ${engine.selected.length} tiles`,
      );
      lastDeployRef.current = { tiles: [...engine.selected], stake };
      sfx("prime");
      void signature;
      refresh();
    } catch (error) {
      setDeployNote(error instanceof Error ? error.message : String(error));
    } finally {
      setDeployBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, active, publicKey, program, mask, stake, engine.selected, refresh]);

  const doDeposit = useCallback(
    async (amount: bigint) => {
      if (!pool || !publicKey || !program || !latestEpochKey) {
        setVaultNote("connect a wallet and make sure an epoch exists");
        return;
      }
      if (amount <= 0n) return;
      setDepositBusy(true);
      setVaultNote(null);
      try {
        sfx("click");
        await deposit(program, { publicKey }, pool, latestEpochKey, amount);
        setVaultNote(
          `deposited ${fmt(amount)} ${symbolOf(pool)} → PT + ET minted`,
        );
        sfx("feed");
        refresh();
      } catch (error) {
        setVaultNote(error instanceof Error ? error.message : String(error));
      } finally {
        setDepositBusy(false);
      }
    },
    [pool, publicKey, program, latestEpochKey, refresh],
  );

  // Auto-request the round draw once buys close (permissionless instruction).
  const autoRequestedRef = useRef<string | null>(publicKey?.toBase58() ?? null);
  autoRequestedRef.current = null; // reset each render; set below per round
  const autoKey =
    active && active.status === ROUND_OPEN
      ? roundKey(active.epochId, active.id)
      : null;
  const autoRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!program || !pool || !publicKey) return;
    if (!autoKey) return;
    if (autoRef.current.has(autoKey)) return;
    // Only fire when the round is actually closed for buys.
    if (
      !active ||
      phaseFor(active, now ?? 0n, pool.roundCloseBufferSeconds) === "mine"
    )
      return;
    autoRef.current.add(autoKey);
    void requestRoundRandomness(
      program,
      { publicKey },
      pool,
      epochAddress(pool.address, active.epochId),
      active.epochId,
      active.id,
    )
      .then(() => refresh())
      .catch(() => {
        // Operator may have raced us; the settle poll covers it either way.
      });
  }, [autoKey, active, now, program, pool, publicKey, refresh]);

  // Auto-rounds: re-deploy the last board when a fresh round opens.
  const lastDeployRef = useRef<{ tiles: number[]; stake: bigint } | null>(null);
  const autoRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoRounds <= 0 || !lastDeployRef.current || !pool) return;
    if (!active || active.status !== ROUND_OPEN) return;
    const key = roundKey(active.epochId, active.id);
    if (autoRoundRef.current === key) return;
    if (position) return;
    if (phaseFor(active, now ?? 0n, pool.roundCloseBufferSeconds) !== "mine")
      return;
    autoRoundRef.current = key;
    setAutoRounds((value) => value - 1);
    const tiles = lastDeployRef.current.tiles;
    const stakeForRound = lastDeployRef.current.stake;
    setStakeText(formatAtomic(stakeForRound, decimals));
    engine.setSelected(tiles);
    void deploy();
  }, [active, autoRounds, position, now, decimals, engine, deploy]);

  // Theme attribute + sound subscription.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => subscribeSound(setSoundOnState), []);

  const canPick = Boolean(
    pool &&
      active &&
      phaseFor(active, now ?? 0n, pool.roundCloseBufferSeconds) === "mine" &&
      !locked &&
      connected,
  );
  const canDeploy = canPick;

  const rewardState = useMemo(() => {
    const settled = engine.settled;
    if (!settled || !publicKey) return null;
    const own = state.positions.get(roundKey(settled.epochId, settled.id));
    if (!own || own.rewardClaimed) return null;
    if (!covers(own.tiles, settled.winningTile)) return null;
    const reward = expectedReward(settled, own);
    if (reward <= 0n) return null;
    return { round: settled, reward };
  }, [engine.settled, state.positions, publicKey]);
  const rewardHint = rewardState
    ? `round #${rewardState.round.id}: you covered tile ${displayTile(rewardState.round.winningTile)} — ${fmt(rewardState.reward)} ET bonus`
    : null;

  const [claimRewardBusy, setClaimRewardBusy] = useState(false);
  const claimReward = useCallback(async () => {
    if (!rewardState || !pool || !publicKey || !program) return;
    setClaimRewardBusy(true);
    try {
      sfx("land");
      await claimRoundReward(
        program,
        { publicKey },
        pool,
        epochAddress(pool.address, rewardState.round.epochId),
        rewardState.round.epochId,
        rewardState.round.id,
      );
      setDeployNote(`round reward claimed: +${fmt(rewardState.reward)} ET`);
      sfx("win");
      refresh();
    } catch (error) {
      setDeployNote(error instanceof Error ? error.message : String(error));
    } finally {
      setClaimRewardBusy(false);
    }
  }, [rewardState, pool, publicKey, program, refresh]);

  const lastWinDisplay = engine.lastWin;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <LogoCog size={28} />
          <span className="brand-logo">HEX.</span>
        </div>
        <nav className="nav" aria-label="Sections">
          {TABS.map((candidate) => (
            <span
              key={candidate}
              role="button"
              className={`nav-item${tab === candidate ? " active" : ""}`}
              data-testid={`tab-${candidate.toLowerCase()}`}
              onClick={() => setTab(candidate)}
            >
              {candidate}
            </span>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="chip" data-testid="cluster-label">
            {cluster}
          </span>
          <span className="chip" data-testid="slot-chip">
            {now !== null ? `T+${now.toString()}` : "SYNC…"}
            <span
              className={`dot ${live ? "ok" : ""}`}
              title={live ? "live events" : "polling fallback"}
            />
          </span>
          <button
            type="button"
            className="toggle"
            data-testid="sound-toggle"
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              setSoundOnState(next);
            }}
            aria-pressed={soundOn}
          >
            <svg width="17" height="16" viewBox="0 0 20 18" aria-hidden="true">
              <path d="M2 6h4l5-4v14l-5-4H2z" fill="var(--primary)" />
              {soundOn ? (
                <path
                  d="M14 5c1.5 1 2.4 2.4 2.4 4s-.9 3-2.4 4"
                  stroke="var(--primary)"
                  strokeWidth="2.2"
                  fill="none"
                  strokeLinecap="round"
                />
              ) : (
                <line
                  x1="13"
                  y1="4"
                  x2="18"
                  y2="14"
                  stroke="#94a3b8"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="toggle"
            data-testid="theme-toggle"
            onClick={() =>
              setTheme((value) => (value === "light" ? "dark" : "light"))
            }
            aria-pressed={theme === "dark"}
          >
            {theme === "dark" ? "☀" : "☾"}
            <span className="toggle-label">
              {theme === "dark" ? "LIGHT" : "DARK"}
            </span>
          </button>
          <span data-testid="wallet-connector">
            <button
              type="button"
              className="btn-connect"
              data-testid="connect-button"
              onClick={() =>
                signer.connected ? signer.disconnect() : signer.connect()
              }
            >
              {!signer.connected
                ? "CONNECT"
                : signer.publicKey
                  ? `${signer.publicKey.toBase58().slice(0, 4)}…${signer.publicKey.toBase58().slice(-4)}`
                  : "DISCONNECT"}
            </button>
          </span>
        </div>
      </header>

      {state.error ? (
        <div className="screen-note err" data-testid="chain-error">
          {state.error}
        </div>
      ) : null}
      {!publicKey ? (
        <div className="connect-hint" data-testid="connect-hint">
          Connect a standard Solana wallet to sign transactions. On localnet you
          can enable the dev burner with VITE_BURNER_WALLET=1.
        </div>
      ) : (
        <div className="connect-hint" data-testid="wallet-address">
          {formatAddress(publicKey.toBase58())} · USDC{" "}
          {fmt(state.balances.accepted)} · PT {fmt(state.balances.principal)} ·
          ET {fmt(state.balances.entries)}
        </div>
      )}

      <main className="main-content-split">
        {tab === "MINE" ? (
          <>
            <Arena
              engine={engine}
              symbol={symbolOf(pool)}
              canPick={canPick}
              onToggleTile={(n) => {
                sfx("click");
                engine.setSelected(
                  engine.selected.includes(n)
                    ? engine.selected.filter((tile) => tile !== n)
                    : [...engine.selected, n],
                );
              }}
            />
            <ControlPanel
              engine={engine}
              balances={state.balances}
              decimals={decimals}
              symbol={symbolOf(pool)}
              stakeText={stakeText}
              setStakeText={setStakeText}
              autoRounds={autoRounds}
              setAutoRounds={setAutoRounds}
              canDeploy={canDeploy}
              deployProblems={problems}
              deployBusy={deployBusy}
              deployNote={deployNote}
              locked={locked}
              deployedTotal={deployedTotal}
              lastWin={lastWinDisplay}
              feed={feed}
              rewardHint={rewardHint}
              claimRewardBusy={claimRewardBusy}
              onClaimReward={() => void claimReward()}
              onDeploy={() => void deploy()}
              onDeposit={(amount) => void doDeposit(amount)}
              depositBusy={depositBusy}
              vaultNote={vaultNote}
            />
          </>
        ) : null}
        {tab === "VAULT" && publicKey && pool ? (
          <Vault
            program={program!}
            owner={publicKey}
            pool={pool}
            latestEpoch={latestEpoch}
            balances={state.balances}
            player={state.player}
            paused={pool.paused}
            onDone={refresh}
          />
        ) : null}
        {tab === "PRIZES" && publicKey && pool ? (
          <Prizes
            program={program!}
            owner={publicKey}
            pool={pool}
            epochs={state.epochs}
            epochRandomness={state.epochRandomness}
            vaults={state.vaults}
            onDone={refresh}
            onWon={setClaimTakeover}
            key={pool.address.toBase58()}
          />
        ) : null}
        {tab === "PRIZES" && (!publicKey || !pool) ? (
          <div className="screen-note err">
            Connect a wallet with a live pool to view prizes.
          </div>
        ) : null}
        {tab === "VAULT" && (!publicKey || !pool) ? (
          <div className="screen-note err">
            Connect a wallet with a live pool to manage custody.
          </div>
        ) : null}
        {tab === "ABOUT" ? (
          <About symbol={symbolOf(pool)} cluster={cluster} />
        ) : null}
      </main>

      {/* Claim takeovers (prize/jackpot claims fire these from PRIZES) */}
      {claimTakeover ? (
        <div
          className="takeover"
          data-testid="claim-takeover"
          onClick={() => setClaimTakeover(null)}
        >
          <div className="takeover-shock" />
          <div className="takeover-title">{claimTakeover.title}</div>
          <div className="takeover-amount">{claimTakeover.amount}</div>
          <div className="takeover-tile">{claimTakeover.tileText}</div>
        </div>
      ) : null}
    </main>
  );
}

// --- helpers -----------------------------------------------------------------

function eventsToRows(rows: EventRow[], owner: string | undefined): FeedRow[] {
  const out: FeedRow[] = [];
  for (const row of rows) {
    const payload = row.payload ?? {};
    const ownerText = typeof payload.owner === "string" ? payload.owner : null;
    const who = ownerText
      ? ownerText === owner
        ? "you"
        : formatAddress(ownerText)
      : "pool";
    if (row.name === "PositionPurchased") {
      const tilesMask = BigInt(String(payload.tiles ?? "0"));
      let count = 0;
      for (let tile = 0; tile < 36; tile += 1)
        if ((tilesMask >> BigInt(tile)) & 1n) count += 1;
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who,
        action: `−${atomicShort(String(payload.total_stake ?? "0"))} ET`,
        tileLabel: `${count} tiles`,
      });
    } else if (row.name === "Deposit") {
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who,
        action: `+${atomicShort(String(payload.amount ?? "0"))} USDC`,
        tileLabel: "deposit",
      });
    } else if (row.name === "RoundSettled") {
      out.push({
        key: `${row.slot}-${row.signature}-${row.eventIndex}`,
        who: "pool",
        action: `tile ${displayTile(Number(payload.winning_tile ?? 0))}`,
        tileLabel: "settled",
      });
    }
  }
  return out;
}

function liveEventToRow(
  event: LiveEvent,
  owner: string | undefined,
): FeedRow | null {
  const data = event.data ?? {};
  const ownerKey =
    typeof data.owner === "string"
      ? data.owner
      : typeof data.user === "string"
        ? data.user
        : null;
  const who = ownerKey
    ? ownerKey === owner
      ? "you"
      : formatAddress(ownerKey)
    : "pool";
  switch (event.name) {
    case "PositionPurchased": {
      const tilesMask = BigInt(String(data.tiles ?? "0"));
      let count = 0;
      for (let tile = 0; tile < 36; tile += 1)
        if ((tilesMask >> BigInt(tile)) & 1n) count += 1;
      return {
        key: event.key,
        who,
        action: `−${atomicShort(String(data.totalStake ?? data.total_stake ?? "0"))} ET`,
        tileLabel: `${count} tiles`,
      };
    }
    case "Deposited":
      return {
        key: event.key,
        who,
        action: `+${atomicShort(String(data.amount ?? "0"))} USDC`,
        tileLabel: "deposit",
      };
    case "RoundSettled":
      return {
        key: event.key,
        who: "pool",
        action: `tile ${displayTile(Number(data.winningTile ?? data.winning_tile ?? 0))}`,
        tileLabel: "settled",
      };
    case "RoundRewardClaimed":
      return {
        key: event.key,
        who,
        action: `+${atomicShort(String(data.reward ?? "0"))} ET`,
        tileLabel: "reward",
      };
    default:
      return null;
  }
}

function mergeFeed(
  live: FeedRow[],
  history: FeedRow[],
  owner: string | undefined,
): FeedRow[] {
  void owner;
  const seen = new Set<string>();
  const out: FeedRow[] = [];
  for (const row of [...live, ...history]) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row);
    if (out.length >= 12) break;
  }
  return out;
}

/** Atomic string (6dp) → compact decimal text without floats. */
function atomicShort(text: string): string {
  const clean = text.replace(/[^0-9]/g, "") || "0";
  const padded = clean.padStart(7, "0");
  const whole = padded.slice(0, padded.length - 6).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
