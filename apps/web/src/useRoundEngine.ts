/**
 * The game choreography: maps chain state onto the designer prototype's
 * phases and animation timeline. Chain is authoritative for state; this hook
 * adds only time-bound presentation (laser path, dot pops, fly tokens,
 * takeovers). All timings derive from chain time via the chain clock.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import {
  covers,
  currentRound,
  displayTile,
  expectedReward,
  latestSettled,
  phaseFor,
  roundKey,
  secondsLeft,
  type FeedRow,
  type Phase,
  type RoundLike,
} from "./engine.js";
import {
  buildFlyTokens,
  computeGeo,
  genPath,
  lastFlyArrivalMs,
  type LaserPath,
} from "./arena/geo.js";
import { sfx } from "./sfx.js";
import type { PositionRow, RoundRow } from "./read.js";

const GEO = computeGeo();

export interface RevealState {
  /** Chain key (epochId:roundId) this reveal animates. */
  key: string;
  /** Protocol tile index 0..35. */
  winningTile: number;
  laser: LaserPath;
  boom: boolean;
  flyTokens: ReturnType<typeof buildFlyTokens>;
  /** dot key → fly launch delay; lattice symbols lift off with their token. */
  flyMap: Record<string, number>;
}

export interface Takeover {
  title: string;
  amount: string;
  tileText: string;
}

export interface EngineOutput {
  phase: Phase;
  /** Seconds until buys close, during the "mine" phase. */
  secondsLeft: bigint;
  /** Protocol tile indexes 0..35 the user has picked. */
  selected: number[];
  setSelected: (tiles: number[]) => void;
  /** Most recent settled round (reveal source); null before any draw. */
  settled: RoundLike | null;
  reveal: RevealState | null;
  banner: string | null;
  takeover: Takeover | null;
  dismissTakeover: () => void;
  /** Hexpot ticker value (atomic units) + pulse flag. */
  hexpot: bigint;
  hexpotPulse: boolean;
  lastWin: { tile: number; kind: string } | null;
  feed: FeedRow[];
  /** The user's position on the current round, if any. */
  activePosition: PositionRow | null;
}

export interface EngineInput {
  rounds: RoundRow[];
  positions: Map<string, PositionRow>;
  owner: PublicKey | undefined;
  poolBufferSeconds: bigint;
  hexpot: bigint;
  clockNow: bigint | null;
  feed: FeedRow[];
}

export function useRoundEngine(input: EngineInput): EngineOutput {
  const {
    rounds,
    positions,
    owner,
    poolBufferSeconds: buffer,
    hexpot,
    clockNow,
    feed,
  } = input;

  const [selected, setSelected] = useState<number[]>([]);
  const [reveal, setRevealState] = useState<RevealState | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  const [hexpotPulse, setHexpotPulse] = useState(false);
  const [lastWin, setLastWin] = useState<{ tile: number; kind: string } | null>(
    null,
  );

  const timeouts = useRef<number[]>([]);
  const later = useCallback((fn: () => void, ms: number): void => {
    const id = window.setTimeout(() => {
      timeouts.current = timeouts.current.filter((value) => value !== id);
      fn();
    }, ms);
    timeouts.current.push(id);
  }, []);

  useEffect(() => {
    return () => {
      timeouts.current.forEach(clearTimeout);
    };
  }, []);

  const setReveal = useCallback(
    (next: RevealState | null) => setRevealState(next),
    [],
  );

  // --- Round reveal choreography --------------------------------------------
  const settled = latestSettled(rounds);
  const settledKey = settled ? roundKey(settled.epochId, settled.id) : null;
  const revealedRef = useRef<Set<string>>(new Set());

  const runReveal = useCallback(
    (round: RoundLike, key: string) => {
      const tileIndex = round.winningTile;
      if (tileIndex < 0 || tileIndex > 35) return; // u8::MAX = "unset" guard
      const tile = GEO.tiles[tileIndex]!;

      const own = owner
        ? positions.get(roundKey(round.epochId, round.id))
        : undefined;
      const won = Boolean(own && covers(own.tiles, tileIndex));
      if (own && !won) later(() => sfx("miss"), 950);

      const laser = genPath(GEO, tile.x, tile.y);
      later(() => sfx("launch"), 0);
      for (const info of Object.values(laser.activeDotTimes)) {
        later(() => sfx("dotTick"), Math.round(info.delay * 1000));
      }

      const flyTokens = buildFlyTokens(laser.activeDotTimes, tile);
      const flyMap: Record<string, number> = {};
      Object.keys(laser.activeDotTimes).forEach((dotKey, index) => {
        if (index < flyTokens.length - 1)
          flyMap[dotKey] = flyTokens[index]!.delay;
      });
      const lastArrival = lastFlyArrivalMs(flyTokens);

      later(() => {
        sfx("land");
        setReveal({
          key,
          winningTile: tileIndex,
          laser,
          boom: true,
          flyTokens,
          flyMap,
        });
        setBanner(`TILE ${displayTile(tileIndex)} WINS`);
        setLastWin({ tile: displayTile(tileIndex), kind: "ROUND" });
      }, 900);

      for (const token of flyTokens) {
        later(
          () => {
            sfx("feed");
            setHexpotPulse(true);
            later(() => setHexpotPulse(false), 260);
          },
          Math.round((token.delay + 0.68) * 1000) + 900,
        );
      }
      later(() => setHexpotPulse(false), lastArrival + 980);

      if (won) {
        const reward = expectedReward(round, own!);
        later(() => {
          sfx("win");
          setTakeover({
            title: "YOU WON",
            amount: `+${formatReward(reward)}`,
            tileText: `Tile ${displayTile(tileIndex)}`,
          });
        }, 1550);
      }

      later(() => {
        setReveal(null);
        setBanner(null);
      }, 4600);
    },
    [owner, positions, later],
  );

  useEffect(() => {
    if (!settled || !settledKey) return;
    if (revealedRef.current.has(settledKey)) return;
    revealedRef.current.add(settledKey);
    runReveal(settled, settledKey);
  }, [settledKey, settled, runReveal]);

  // --- Hexpot pulse on live vault movement -----------------------------------
  const hexpotRef = useRef(hexpot);
  useEffect(() => {
    if (hexpotRef.current !== hexpot) {
      hexpotRef.current = hexpot;
      setHexpotPulse(true);
      later(() => setHexpotPulse(false), 260);
    }
  }, [hexpot, later]);

  // --- Derived phase ----------------------------------------------------------
  const now = clockNow ?? 0n;
  const active = currentRound(rounds);
  const phase = phaseFor(active, now, buffer);
  const activeSecondsLeft =
    active && phase === "mine" ? secondsLeft(active, buffer, now) : 0n;
  const activePosition =
    owner && active
      ? (positions.get(roundKey(active.epochId, active.id)) ?? null)
      : null;

  return {
    phase,
    secondsLeft: activeSecondsLeft,
    selected,
    setSelected,
    settled,
    reveal,
    banner,
    takeover,
    dismissTakeover: () => setTakeover(null),
    hexpot,
    hexpotPulse,
    lastWin,
    feed,
    activePosition,
  };
}

/** Atomic (6dp) → "x.yyy" string without floats. */
export function formatReward(amount: bigint): string {
  const text = amount.toString();
  return text.length <= 3
    ? `0.${text.padStart(3, "0")}`
    : `${text.slice(0, -3)}.${text.slice(-3)}`;
}
