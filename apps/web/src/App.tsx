/** MINE screen wiring: header, arena + control panel, tabs, live events. */
import { AnchorProvider, Program } from "@anchor-lang/core";
import { useConnection } from "@solana/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { eventsToRows, liveEventToRow, mergeFeed } from "./activityRows.js";
import { Arena, LogoCog, LogoWordmark } from "./arena/Arena.js";
import { BetDrawer } from "./panel/BetDrawer.js";
import { ControlPanel } from "./panel/ControlPanel.js";
import { StakeBarButton } from "./panel/StakeBarButton.js";
import { About } from "./screens/About.js";
import { Home } from "./screens/Home.js";
import { Leaderboard } from "./screens/Leaderboard.js";
import { Vault } from "./screens/Vault.js";
import { WeeklyDraw } from "./screens/WeeklyDraw.js";
import { buyPosition, settlePosition } from "./actions.js";
import { apiBaseUrl, fetchFeed, fetchStatus } from "./api.js";
import { type HexVaultProgram } from "./chain.js";
import { idl } from "./idl.js";
import {
  covers,
  decideAutoRound,
  displayTile,
  expectedReward,
  isRevealed,
  phaseFor,
  type FeedRow,
  type RememberedBoard,
} from "./engine.js";
import {
  formatAtomic,
  formatAtomic2,
  parseAtomic,
  withdrawable,
} from "./lib/money.js";
import { sfx, setSoundOn, subscribeSound, isSoundOn } from "./sfx.js";
import { SoundIcon } from "./SoundIcon.js";
import { WalletMenu } from "./WalletMenu.js";
import { useChainState } from "./read.js";
import { useChainClock } from "./useChainClock.js";
import { useProgramEvents } from "./useProgramEvents.js";
import { useApiPoll } from "./useApiPoll.js";
import { useRoundEngine } from "./useRoundEngine.js";
import { useGameSigner } from "./wallets.js";
import { summarizeStatus } from "./status.js";
import { TABS, tabFromHash, type Tab } from "./tabs.js";

/** The accepted asset is hexUSDC (6 decimals) for every pool in this build. */
const SYMBOL = "hexUSDC";
const DECIMALS = 6;
/**
 * How long after a round ends before the manual SETTLE POSITION button shows.
 * The operator settles one batch per 2 s tick, so a healthy crank clears a
 * round well inside this; the button is the fallback for a stalled one.
 * ponytail: fixed guess, derive from batch size × tick if rounds get crowded.
 */
const SETTLE_GRACE_SECONDS = 30n;

export function App() {
  const { connection } = useConnection();
  const signer = useGameSigner();
  const { publicKey, connected, sendTransaction } = signer;
  // What the actions sign with: the address plus, for the Privy embedded
  // wallet, its sponsored send path. Keyed on the two so the action
  // callbacks below don't rebuild on every signer object Privy hands back.
  const txSigner = useMemo(
    () => (publicKey ? { publicKey, sendTransaction } : null),
    [publicKey, sendTransaction],
  );
  const [tab, setTab] = useState<Tab>(() =>
    tabFromHash(window.location.hash),
  );
  const [soundOn, setSoundOnState] = useState(isSoundOn());
  // Dark only: the toggle is gone, but the light tokens and the
  // `data-theme` attribute stay so re-enabling it is a one-line change.
  const [theme] = useState<"light" | "dark">("dark");
  const [stakeText, setStakeText] = useState("1");
  const [autoRounds, setAutoRounds] = useState(0);
  const [addressCopied, setAddressCopied] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  const [feedHistory, setFeedHistory] = useState<FeedRow[]>([]);
  // Phone bet drawer (spec.md "Drawer"): controlled here so the deploy
  // success path and the win takeover path can both close it.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Privy and wallet-adapter hand back a fresh signer object on every render,
  // so memoizing the provider on it rebuilt the Program every render — and the
  // chain reads keyed off that Program write state, so the app looped:
  // read → render → new Program → read, as fast as the RPC answered. Key the
  // provider on the address and reach the live signer through a ref, so one
  // Program survives across renders.
  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);
  const ownerAddress = signer.publicKey?.toBase58();
  const provider = useMemo(() => {
    const sign = async <T,>(tx: T): Promise<T> => {
      const signTransaction = signerRef.current.signTransaction;
      if (!signTransaction) throw new Error("wallet cannot sign transactions");
      return (await signTransaction(tx as never)) as T;
    };
    const wallet = {
      get publicKey() {
        return signerRef.current.publicKey;
      },
      signTransaction: sign,
      signAllTransactions: <T,>(txs: T[]) => Promise.all(txs.map(sign)),
    };
    return new AnchorProvider(connection, wallet as never, {
      commitment: "confirmed",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ownerAddress stands in for the signer, on purpose
  }, [connection, ownerAddress]);
  const program = useMemo<HexVaultProgram | null>(
    () => new Program(idl, provider) as unknown as HexVaultProgram,
    [provider],
  );

  const state = useChainState(connection, program, publicKey ?? undefined);
  const pool = state.pool;
  const player = state.player;
  const round = state.round;
  const { now } = useChainClock(connection);
  const { events } = useProgramEvents(program, connection);
  const loadStatus = useCallback(
    (signal: AbortSignal) => fetchStatus(apiBaseUrl(), signal),
    [],
  );
  const statusPoll = useApiPoll(loadStatus, 2000);
  const status = useMemo(
    () => summarizeStatus(statusPoll.data, Date.now()),
    [statusPoll.data],
  );
  // Live rows only; GET /feed history is never held, so it joins after the
  // engine below rather than passing through the hold filter.
  const ownerKey = publicKey?.toBase58();
  const liveFeed = useMemo<FeedRow[]>(() => {
    const rows: FeedRow[] = [];
    for (const event of events) {
      const row = liveEventToRow(event, ownerKey);
      if (row) rows.push(row);
    }
    return rows;
  }, [events, ownerKey]);
  const engine = useRoundEngine({
    round,
    position: state.position,
    owner: publicKey ?? undefined,
    closeBuffer: pool?.closeBuffer ?? 0n,
    clockNow: now,
    feed: liveFeed,
  });

  // `takeover` only ever fires for the Player's own Position (useRoundEngine
  // sets it inside `if (won)`), so this is exactly spec.md's "a win takeover
  // for the Player's own Position closes the drawer".
  useEffect(() => {
    if (engine.takeover) setDrawerOpen(false);
  }, [engine.takeover]);

  const refresh = state.refresh;
  const principal = player?.principal ?? 0n;
  const entries = player?.entries ?? 0n;
  const fmt = useCallback((value: bigint) => formatAtomic2(value, DECIMALS), []);

  // Header chip copies the full address; the truncated form is unusable for
  // funding. Clipboard needs a secure context, so fall back to a prompt.
  const copyAddress = useCallback(async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      window.setTimeout(() => setAddressCopied(false), 1200);
    } catch {
      window.prompt("Copy address", address);
    }
  }, []);

  // Feed: /feed history first, then live events on top.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await fetchFeed(apiBaseUrl(), 12, controller.signal);
      if (result.ok)
        setFeedHistory(eventsToRows(result.data, publicKey?.toBase58()));
    })();
    return () => controller.abort();
  }, [publicKey]);

  const feed = useMemo(
    () => mergeFeed(engine.feed, feedHistory),
    [engine.feed, feedHistory],
  );

  // --- Actions ---------------------------------------------------------------
  const stake = parseAtomic(stakeText, DECIMALS) ?? 0n;
  const position = engine.activePosition;
  const openRound = round && round.status === 0 ? round : null;
  const locked = Boolean(position) && Boolean(openRound);
  const deployedTotal = position
    ? BigInt(position.tiles.toString(2).replace(/[^1]/g, "").length) *
      position.stakePerTile
    : 0n;
  const spend = stake * BigInt(engine.selected.length);

  const problems: string[] = [];
  if (!pool) problems.push("no pool found on chain yet");
  if (!openRound) problems.push("no open round (the operator opens rounds)");
  if (
    openRound &&
    phaseFor(openRound, now ?? 0n, pool?.closeBuffer ?? 0n) !== "mine"
  )
    problems.push("positions are closed for this round");
  if (locked && openRound)
    problems.push(`position already placed in round #${openRound.roundId}`);
  if (spend > entries)
    problems.push("not enough Tickets — deposit to earn more");

  /** Places `tiles` at `stakeAmount` per tile in the open round. Returns whether the transaction was sent. */
  const deploy = useCallback(
    async (tiles: number[], stakeAmount: bigint): Promise<boolean> => {
      if (!pool || !openRound || !txSigner || !program) return false;
      if (tiles.length === 0 || stakeAmount <= 0n) return false;
      setDeployBusy(true);
      setDeployNote(null);
      try {
        sfx("click");
        const tileMask = tiles.reduce(
          (acc, tile) => acc | (1n << BigInt(tile - 1)),
          0n,
        );
        const spendNow = stakeAmount * BigInt(tiles.length);
        await buyPosition(
          program,
          txSigner,
          pool,
          openRound.roundId,
          tileMask,
          stakeAmount,
        );
        const entriesAfter = entries - spendNow;
        setDeployNote(
          `Tickets in ${fmt(spendNow)} · Tickets after ${fmt(entriesAfter)} · withdrawable after ${fmt(withdrawable(principal, entriesAfter))}`,
        );
        lastDeployRef.current = { tiles: [...tiles], stake: stakeAmount };
        sfx("prime");
        refresh();
        return true;
      } catch (error) {
        setDeployNote(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setDeployBusy(false);
      }
    },
    [pool, openRound, txSigner, program, entries, principal, fmt, refresh],
  );

  // Auto-rounds: re-place the last board when a fresh round opens. The
  // counter and the "handled this round" marker only move after deploy()
  // reports the transaction was actually sent — a board that can't be
  // placed (see decideAutoRound) leaves both alone, so it retries next
  // round instead of silently eating one.
  const lastDeployRef = useRef<RememberedBoard | null>(null);
  const autoRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (autoRounds <= 0 || !pool || !openRound || deployBusy) return;
    const key = openRound.roundId.toString();
    if (autoRoundRef.current === key) return;
    const phase = phaseFor(openRound, now ?? 0n, pool.closeBuffer);
    const decision = decideAutoRound(
      lastDeployRef.current,
      entries,
      phase,
      Boolean(position),
    );
    if (decision.action === "skip") return;
    const { tiles, stake: stakeForRound } = decision;
    void (async () => {
      const placed = await deploy(tiles, stakeForRound);
      if (!placed) return;
      autoRoundRef.current = key;
      setAutoRounds((value) => value - 1);
      setStakeText(formatAtomic(stakeForRound, DECIMALS));
      engine.setSelected(tiles);
    })();
  }, [
    openRound,
    autoRounds,
    position,
    now,
    pool,
    entries,
    deployBusy,
    engine,
    deploy,
  ]);

  // Theme attribute + sound subscription.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => subscribeSound(setSoundOnState), []);

  const canPick = Boolean(
    pool &&
      openRound &&
      phaseFor(openRound, now ?? 0n, pool.closeBuffer) === "mine" &&
      !locked &&
      connected,
  );

  // A revealed round leaves the Position open until it is settled; that is the
  // permissionless instruction which credits the round reward as Entries. The
  // operator sweeps positions every tick, so the manual button only shows once
  // the round has been over long enough that the sweep is clearly behind.
  const settleState = useMemo(() => {
    if (!round || !position || !publicKey) return null;
    if (!isRevealed(round)) return null;
    if ((now ?? 0n) < round.endsAt + SETTLE_GRACE_SECONDS) return null;
    const reward = covers(position.tiles, round.winningTile)
      ? expectedReward(round, position)
      : 0n;
    return { roundId: round.roundId, winningTile: round.winningTile, reward };
  }, [round, position, publicKey, now]);
  const rewardHint = settleState
    ? settleState.reward > 0n
      ? `round #${settleState.roundId}: you covered tile ${displayTile(settleState.winningTile)} — settle for +${fmt(settleState.reward)} Tickets`
      : `round #${settleState.roundId}: settle to close your position and get its rent back`
    : null;

  const [settleBusy, setSettleBusy] = useState(false);
  const settle = useCallback(async () => {
    if (!settleState || !pool || !txSigner || !program) return;
    setSettleBusy(true);
    try {
      sfx("land");
      await settlePosition(program, txSigner, pool, settleState.roundId);
      setDeployNote(
        settleState.reward > 0n
          ? `round reward settled: +${fmt(settleState.reward)} Tickets`
          : "position settled",
      );
      if (settleState.reward > 0n) sfx("win");
      refresh();
    } catch (error) {
      setDeployNote(error instanceof Error ? error.message : String(error));
    } finally {
      setSettleBusy(false);
    }
  }, [settleState, pool, txSigner, program, fmt, refresh]);

  return (
    <main className="app">
      <header className="topbar">
        <button
          type="button"
          className="brand"
          aria-label="Home"
          onClick={() => setTab("HOME")}
        >
          <LogoCog size={34} />
          <span className="brand-logo">
            <LogoWordmark height={15} />
          </span>
        </button>
        <nav className="nav" aria-label="Sections">
          {TABS.map((candidate) => {
            // PLAY needs Tickets; aria-disabled (not `disabled`) keeps the
            // button hoverable so the data-tip tooltip (styles.css) shows.
            const locked = candidate.id === "MINE" && entries === 0n;
            return (
              <button
                key={candidate.id}
                type="button"
                className={`nav-item${tab === candidate.id ? " active" : ""}`}
                data-testid={`tab-${candidate.id.toLowerCase()}`}
                aria-disabled={locked}
                data-tip={locked ? "Deposit first to play" : undefined}
                onClick={locked ? undefined : () => setTab(candidate.id)}
              >
                <span className="nav-item-long">{candidate.long}</span>
                <span className="nav-item-short">{candidate.short}</span>
              </button>
            );
          })}
        </nav>
        <div className="topbar-right">
          {connected ? (
            <>
              <span className="chip" data-testid="topbar-tickets">
                Tickets: {fmt(entries)}
              </span>
              <span className="chip" data-testid="topbar-balance">
                {SYMBOL}: {fmt(state.walletBalance)}
              </span>
            </>
          ) : null}
          <button
            type="button"
            className="sound-toggle"
            data-testid="sound-toggle"
            onClick={() => {
              const next = !soundOn;
              setSoundOn(next);
              setSoundOnState(next);
            }}
            aria-pressed={soundOn}
            aria-label="Sound"
          >
            <SoundIcon on={soundOn} />
          </button>
          {signer.connected && signer.publicKey ? (
            <WalletMenu
              address={signer.publicKey.toBase58()}
              tickets={fmt(entries)}
              balance={fmt(state.walletBalance)}
              symbol={SYMBOL}
              addressCopied={addressCopied}
              onCopy={(address) => void copyAddress(address)}
              onDisconnect={() => signer.disconnect()}
            />
          ) : (
            <span data-testid="wallet-connector">
              <button
                type="button"
                className="btn-connect"
                data-testid="connect-button"
                onClick={() =>
                  signer.connected ? signer.disconnect() : signer.connect()
                }
              >
                {signer.connected ? "DISCONNECT" : "CONNECT"}
              </button>
            </span>
          )}
        </div>
      </header>

      {state.error ? (
        <div className="screen-note err" data-testid="chain-error">
          {state.error}
        </div>
      ) : null}

      <main className="main-content-split">
        {tab === "HOME" ? (
          <Home now={now} onDeposit={() => setTab("VAULT")} />
        ) : null}
        {tab === "MINE" ? (
          <>
            <Arena
              engine={engine}
              canPick={canPick}
              operatorStale={status.stale}
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
              entries={entries}
              decimals={DECIMALS}
              stakeText={stakeText}
              setStakeText={setStakeText}
              autoRounds={autoRounds}
              setAutoRounds={setAutoRounds}
              canDeploy={canPick}
              deployProblems={problems}
              deployBusy={deployBusy}
              deployNote={deployNote}
              locked={locked}
              deployedTotal={deployedTotal}
              lastWin={engine.lastWin}
              feed={feed}
              rewardHint={rewardHint}
              settleBusy={settleBusy}
              onSettle={() => void settle()}
              onDeploy={() => void deploy(engine.selected, stake)}
            />
            <StakeBarButton
              stakeText={stakeText}
              selected={engine.selected}
              position={position}
              phase={engine.phase}
              decimals={DECIMALS}
              onOpen={() => setDrawerOpen(true)}
            />
            <BetDrawer
              open={drawerOpen}
              onOpenChange={setDrawerOpen}
              soundOn={soundOn}
              onToggleSound={() => {
                const next = !soundOn;
                setSoundOn(next);
                setSoundOnState(next);
              }}
            >
              <ControlPanel
                engine={engine}
                entries={entries}
                decimals={DECIMALS}
                stakeText={stakeText}
                setStakeText={setStakeText}
                autoRounds={autoRounds}
                setAutoRounds={setAutoRounds}
                canDeploy={canPick}
                deployProblems={problems}
                deployBusy={deployBusy}
                deployNote={deployNote}
                locked={locked}
                deployedTotal={deployedTotal}
                lastWin={engine.lastWin}
                feed={feed}
                rewardHint={rewardHint}
                settleBusy={settleBusy}
                onSettle={() => void settle()}
                onDeploy={() => {
                  // Confirmed deploy closes the drawer; a failed one leaves
                  // it open with deployNote's error visible (spec.md
                  // "Drawer": close states).
                  void deploy(engine.selected, stake).then((placed) => {
                    if (placed) setDrawerOpen(false);
                  });
                }}
              />
            </BetDrawer>
          </>
        ) : null}
        {tab === "VAULT" ? (
          <Vault
            program={program}
            owner={publicKey ?? null}
            sendTransaction={sendTransaction}
            pool={pool}
            principal={principal}
            entries={entries}
            walletBalance={state.walletBalance}
            paused={pool?.paused ?? false}
            now={now}
            aprBps={statusPoll.data?.aprBps ?? null}
            onConnect={() => signer.connect()}
            onDone={refresh}
            onPlay={() => setTab("MINE")}
          />
        ) : null}
        {tab === "WEEKLY DRAW" ? (
          <WeeklyDraw
            program={program}
            owner={publicKey ?? undefined}
            sendTransaction={sendTransaction}
            pool={pool}
            now={now}
            onDone={refresh}
          />
        ) : null}
        {tab === "LEADERBOARD" ? (
          <Leaderboard owner={publicKey ?? undefined} />
        ) : null}
        {tab === "ABOUT" ? <About symbol={SYMBOL} /> : null}
      </main>
    </main>
  );
}
