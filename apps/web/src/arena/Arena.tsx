/**
 * Hexagon arena — React port of the "HEX Voltage Refined" prototype stage:
 * countdown, hexagon outline, dot lattice, cog core, laser reveal, 36 tiles,
 * victory shockwaves, hexpot odometer ticker, and the win takeover modal.
 */
import { useMemo } from "react";

import { computeGeo } from "./geo.js";
import { Textile } from "./Textile.js";
import { timerText } from "../engine.js";
import type { EngineOutput } from "../useRoundEngine.js";

const GEO = computeGeo();

export function LogoCog({
  size = 28,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  // Six-hexagon honeycomb flower from the Figma source (Dark Gold edition).
  // `size` is the width; the flower is 21 × 25.2 units.
  const height = Math.round(size * (25.2 / 21));
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 21 25.2"
      fill="none"
      style={{ display: "block", flexShrink: 0 }}
    >
      {[
        "M10.5 0L14 2.1V6.3L10.5 8.4L7 6.3V2.1L10.5 0Z",
        "M17.5 4.2L21 6.3V10.5L17.5 12.6L14 10.5V6.3L17.5 4.2Z",
        "M17.5 12.6L21 14.7V18.9L17.5 21L14 18.9V14.7L17.5 12.6Z",
        "M10.5 16.8L14 18.9V23.1L10.5 25.2L7 23.1V18.9L10.5 16.8Z",
        "M3.5 12.6L7 14.7V18.9L3.5 21L0 18.9V14.7L3.5 12.6Z",
        "M3.5 4.2L7 6.3V10.5L3.5 12.6L0 10.5V6.3L3.5 4.2Z",
      ].map((d) => (
        <path key={d} d={d} fill={color} />
      ))}
    </svg>
  );
}

/** Atomic (6dp) → ticker tenths, capped at the odometer's 999.9 capacity. */
export const hexpotTenths = (atomic: bigint): number => {
  const tenths = atomic / 100_000n;
  return Number(tenths > 9999n ? 9999n : tenths);
};

const ODOMETER: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function Reel({ digit }: { digit: number }) {
  return (
    <span className="hp-reel">
      <span
        className="hp-strip"
        style={{ transform: `translateY(${-digit * 22}px)` }}
      >
        {ODOMETER.map((value) => (
          <span key={value} className="hp-digit">
            {value}
          </span>
        ))}
      </span>
    </span>
  );
}

export function HexpotTicker({
  value,
  pulse,
  symbol,
}: {
  value: bigint;
  pulse: boolean;
  symbol: string;
}) {
  const tenths = hexpotTenths(value);
  const hundreds = Math.floor(tenths / 1000) % 10;
  const tens = Math.floor(tenths / 100) % 10;
  const ones = Math.floor(tenths / 10) % 10;
  const tenth = tenths % 10;
  return (
    <div className="hexpot" data-testid="hexpot-ticker" data-value={tenths}>
      <div className="hexpot-info-wrap">
        <span className="hexpot-label">HEXPOT</span>
        <span className="info-bubble-icon">i</span>
        <div className="hexpot-tooltip">
          <div className="hexpot-tooltip-title">HEXPOT</div>
          <div>
            The pool's prize vault: this week's simulated yield plus anything
            held over from earlier draws. The weekly draw pays it to one winner.
            Not your Principal.
          </div>
        </div>
      </div>
      <span
        className="hp-value"
        style={{ transform: pulse ? "scale(1.18)" : "scale(1)" }}
      >
        <Reel digit={hundreds} />
        <Reel digit={tens} />
        <Reel digit={ones} />
        <span className="hp-sep">.</span>
        <Reel digit={tenth} />
      </span>
      <span className="hexpot-symbol">{symbol}</span>
    </div>
  );
}

export interface ArenaProps {
  engine: EngineOutput;
  /** Unit under the hexpot odometer: the pool's accepted asset. */
  symbol: string;
  canPick: boolean;
  onToggleTile: (displayNumber: number) => void;
  /** True when the backend status pill is amber: the operator isn't ticking. */
  operatorStale?: boolean;
}

export function Arena({
  engine,
  symbol,
  canPick,
  onToggleTile,
  operatorStale = false,
}: ArenaProps) {
  const {
    phase,
    secondsLeft,
    selected,
    reveal,
    banner,
    hexpot,
    hexpotPulse,
    coreEnter,
    takeover,
    dismissTakeover,
  } = engine;

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // The winner lights up when the laser lands (boom), not when it launches.
  const winDisplay = reveal?.boom ? reveal.winningTile + 1 : 0;
  const revealDots = reveal?.laser.activeDotTimes ?? {};
  const flyMap = reveal?.flyMap ?? {};
  const seconds = Number(secondsLeft);
  const showTimer =
    phase === "mine" || phase === "locked" || phase === "settling";
  // secondsLeft is already 0 outside "mine"/"locked", so this reads 00:00
  // through "settling" for free.
  const timerLabel = timerText(secondsLeft);
  const timerRed = (phase === "mine" || phase === "locked") && seconds <= 2;

  const shake =
    phase === "settling"
      ? "hexShake .08s infinite"
      : phase === "mine" || phase === "locked"
        ? seconds <= 5
          ? "hexShake .08s infinite"
          : "hexShakeSubtle .25s infinite"
        : "none";

  return (
    <div className="stage-arena-wrap" data-testid="arena">
      <div className="hex-stage-container">
        {/* Timer / win banner above the hexagon */}
        {showTimer && !banner ? (
          <div
            className={`stage-timer${operatorStale ? " stage-timer-stale" : ""}${timerRed && !operatorStale ? " stage-timer-red" : ""}`}
            data-testid="round-timer"
          >
            {operatorStale ? "OPERATOR PAUSED" : timerLabel}
          </div>
        ) : null}
        {banner ? (
          <div className="win-banner" data-testid="win-banner">
            <span>{banner}</span>
          </div>
        ) : null}

        {/* Static hexagon body */}
        <div className="stage-hex">
          <svg width={620} height={600} aria-hidden="true">
            <polygon
              points={GEO.hexPts}
              fill="none"
              stroke="var(--hex-stroke)"
              strokeWidth="1.6"
            />
          </svg>

          {/* Dot lattice */}
          {GEO.dots.map((dot) => {
            const info = revealDots[dot.key];
            const launch = flyMap[dot.key];
            let anim = "none";
            if (info) {
              anim = reveal?.clearing
                ? "symbolFadeOut .65s ease-in forwards"
                : launch === undefined
                  ? `symbolPop .36s cubic-bezier(.17,.89,.32,1.28) forwards ${info.delay}s`
                  : `symbolFadeOut .18s ease-in forwards ${launch}s`;
            }
            return (
              <div
                key={dot.key}
                className="dot-cell"
                style={{ left: dot.x, top: dot.y }}
              >
                {info ? (
                  <div className="dot-symbol" style={{ animation: anim }}>
                    <Textile sym={info.sym} />
                  </div>
                ) : (
                  <div className="dot-untouched" />
                )}
              </div>
            );
          })}

          {/* Central honeycomb core while the round is live */}
          {phase === "mine" || phase === "locked" || phase === "settling" ? (
            <div
              className="stage-core"
              style={{
                left: GEO.cx,
                top: GEO.cy,
                animation: coreEnter
                  ? "coreFadeIn .85s ease-out forwards"
                  : shake,
              }}
            >
              <div
                style={{
                  transform: `scale(${(phase === "mine" || phase === "locked") && seconds <= 5 ? (1 + (5 - Math.min(5, seconds)) * 0.25).toFixed(3) : 1})`,
                  transformOrigin: "center center",
                  transition: "transform .18s linear",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <LogoCog size={60} />
              </div>
            </div>
          ) : reveal ? (
            // The core detonates at the fire instant; coreHexExplode ends at
            // opacity 0 and holds there ("forwards") for the rest of the
            // reveal. Keyed on the reveal so a queued second reveal restarts it.
            <div
              key={reveal.key}
              className="stage-core"
              style={{
                left: GEO.cx,
                top: GEO.cy,
                animation: "coreHexExplode .9s ease-out forwards",
              }}
            >
              <LogoCog size={60} />
            </div>
          ) : null}

          {/* Laser */}
          {reveal ? (
            <svg
              width={620}
              height={600}
              className="stage-laser"
              aria-hidden="true"
            >
              <path
                d={reveal.laser.pathD}
                pathLength={100}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="3.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle r={4.5} fill="var(--primary)">
                <animateMotion
                  dur="0.9s"
                  fill="freeze"
                  path={reveal.laser.pathD}
                />
              </circle>
            </svg>
          ) : null}

          {/* 36 tiles */}
          {GEO.tiles.map((tile) => {
            const isWin = winDisplay === tile.n;
            const isSel = selectedSet.has(tile.n);
            const cls = [
              "tile-cell",
              isWin ? "tile-winner" : "",
              isSel ? "tile-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={tile.n}
                className={cls}
                data-testid={`tile-${tile.n - 1}`}
                data-selected={isSel ? "1" : "0"}
                style={{
                  left: tile.x,
                  top: tile.y,
                  transform: `rotate(${tile.rot}deg)`,
                }}
                onClick={() => canPick && onToggleTile(tile.n)}
              >
                <div className="tile-face">
                  <span
                    style={{
                      transform: `rotate(${-tile.rot}deg)`,
                      display: "block",
                    }}
                  >
                    {tile.n}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Victory shockwaves */}
          {reveal && reveal.boom ? (
            <>
              <div
                className="shock-ring"
                style={{
                  left: GEO.tiles[reveal.winningTile]!.x,
                  top: GEO.tiles[reveal.winningTile]!.y,
                }}
              />
              <div
                className="shock-ring alt"
                style={{
                  left: GEO.tiles[reveal.winningTile]!.x,
                  top: GEO.tiles[reveal.winningTile]!.y,
                }}
              />
            </>
          ) : null}

          {/* Fly tokens into the hexpot */}
          {reveal
            ? reveal.flyTokens.map((token, index) => (
                <div
                  key={index}
                  className="fly-symbol-token"
                  style={{
                    offsetPath: `path("${token.pathD}")`,
                    animationDelay: `${token.delay}s`,
                  }}
                >
                  <div
                    className="fly-symbol-art"
                    style={{ animationDelay: `${token.delay}s` }}
                  >
                    <Textile sym={token.sym} />
                  </div>
                </div>
              ))
            : null}
        </div>

        <HexpotTicker value={hexpot} pulse={hexpotPulse} symbol={symbol} />
      </div>

      {/* Round win takeover */}
      {takeover ? (
        <div
          className="takeover"
          data-testid="takeover"
          data-title={takeover.title}
          onClick={dismissTakeover}
        >
          <div className="takeover-shock" />
          <div className="takeover-title">{takeover.title}</div>
          <div className="takeover-amount" data-testid="takeover-amount">
            {takeover.amount}
          </div>
          <div className="takeover-tile">{takeover.tileText}</div>
        </div>
      ) : null}
    </div>
  );
}
