/**
 * Hexagon arena — React port of the "HEX Voltage Refined" prototype stage:
 * countdown, hexagon outline, dot lattice, cog core, laser reveal, 36 tiles,
 * victory shockwaves, hexpot odometer ticker, and the win takeover modal.
 */
import { useMemo } from "react";

import { computeGeo } from "./geo.js";
import { Textile } from "./Textile.js";
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
          <div className="hexpot-tooltip-title">ROUND REWARD POOL</div>
          <div>
            Shared jackpot distributed to miners on the winning tile. This is a
            game prize, not your personal wallet balance.
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
  symbol: string;
  canPick: boolean;
  onToggleTile: (displayNumber: number) => void;
}

export function Arena({ engine, symbol, canPick, onToggleTile }: ArenaProps) {
  const {
    phase,
    secondsLeft,
    selected,
    reveal,
    banner,
    hexpot,
    hexpotPulse,
    takeover,
    dismissTakeover,
  } = engine;

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const winDisplay = reveal ? reveal.winningTile + 1 : 0;
  const revealDots = reveal?.laser.activeDotTimes ?? {};
  const flyMap = reveal?.flyMap ?? {};
  const seconds = Number(secondsLeft);
  const danger = phase === "mine" && seconds <= 2;
  const showTimer = phase === "mine" || phase === "settling";
  const timerText =
    phase === "mine"
      ? `00:${String(Math.min(59, seconds)).padStart(2, "0")}`
      : "00:00";

  const shake =
    phase === "mine"
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
            className={`arena-timer${danger ? " danger" : ""}`}
            data-testid="round-timer"
          >
            {timerText}
          </div>
        ) : null}
        {banner ? (
          <div className="arena-banner" data-testid="win-banner">
            <span>{banner}</span>
          </div>
        ) : null}
        {phase === "awaiting" && !banner ? (
          <div className="arena-awaiting" data-testid="awaiting-note">
            AWAITING NEXT ROUND
          </div>
        ) : null}

        {/* Static hexagon body */}
        <div className="hex-body">
          <svg
            width={620}
            height={600}
            className="hex-outline"
            aria-hidden="true"
          >
            <polygon
              points={GEO.hexPts}
              fill="none"
              stroke="var(--tHexStroke)"
              strokeWidth="1.6"
            />
          </svg>

          {/* Dot lattice */}
          {GEO.dots.map((dot) => {
            const info = revealDots[dot.key];
            const launch = flyMap[dot.key];
            let anim = "none";
            if (info) {
              anim =
                launch === undefined
                  ? `symbolPop .36s cubic-bezier(.17,.89,.32,1.28) forwards ${info.delay}s`
                  : `symbolFadeOut .18s ease-in forwards ${launch}s`;
            }
            return (
              <div
                key={dot.key}
                className="lattice-dot"
                style={{ left: dot.x, top: dot.y }}
              >
                {info ? (
                  <div className="dot-symbol" style={{ animation: anim }}>
                    <Textile sym={info.sym} />
                  </div>
                ) : (
                  <div className="dot-plain" />
                )}
              </div>
            );
          })}

          {/* Center cog core during live mining */}
          {phase === "mine" ? (
            <div
              className="core"
              style={{ left: GEO.cx, top: GEO.cy, animation: shake }}
            >
              <div className="core-intro">
                <div
                  className="core-scale"
                  style={{
                    transform: `scale(${seconds <= 5 ? (1 + (5 - Math.min(5, seconds)) * 0.25).toFixed(3) : 1})`,
                  }}
                >
                  <div className="core-spin">
                    <LogoCog size={72} />
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {phase === "settling" ? (
            <div
              className="core-await"
              style={{ left: GEO.cx, top: GEO.cy }}
              data-testid="draw-pending"
            >
              <span>DRAW PENDING</span>
            </div>
          ) : null}

          {/* Laser */}
          {reveal ? (
            <svg
              width={620}
              height={600}
              className="hex-outline"
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
                style={{
                  strokeDasharray: "26 100",
                  strokeDashoffset: 26,
                  animation:
                    "fixedLineTravel .9s cubic-bezier(.2,.85,.2,1) forwards",
                }}
              />
              <circle
                r={4.5}
                fill="var(--primary)"
                style={{ animation: "laserNodeFade .9s forwards" }}
              >
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
              isWin ? "win" : "",
              isSel ? "selected" : "",
              canPick ? "pickable" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={tile.n}
                className={cls}
                data-testid={`tile-${tile.n - 1}`}
                data-selected={isSel ? "1" : "0"}
                style={{ left: tile.x, top: tile.y }}
                onClick={() => canPick && onToggleTile(tile.n)}
              >
                <div
                  className="tile-face"
                  style={{ transform: `rotate(${tile.rot}deg)` }}
                >
                  <span style={{ transform: `rotate(${-tile.rot}deg)` }}>
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
                className="shock blue"
                style={{
                  left: GEO.tiles[reveal.winningTile]!.x,
                  top: GEO.tiles[reveal.winningTile]!.y,
                }}
              />
              <div
                className="shock red"
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

      {/* Win / jackpot takeover */}
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
