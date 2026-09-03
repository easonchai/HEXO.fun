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
  color = "#0022ff",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      style={{ display: "block" }}
    >
      <path
        d="M29.2932 8.44817C29.6107 8.62452 29.8076 8.95917 29.8076 9.32238V12.1244C29.8076 12.8868 30.6267 13.3688 31.2932 12.9986L33.8385 11.5847C34.1406 11.417 34.5078 11.417 34.8098 11.5848L39.6166 14.2557C39.934 14.4321 40.1309 14.7667 40.1309 15.1299V20.4053C40.1309 20.7684 39.934 21.1031 39.6166 21.2794L36.6054 22.9525C35.9197 23.3336 35.9197 24.3198 36.6054 24.7008L39.6166 26.3739C39.934 26.5503 40.1309 26.8849 40.1309 27.248V32.5235C40.1309 32.8866 39.934 33.2212 39.6166 33.3976L34.8099 36.0685C34.5079 36.2363 34.1406 36.2363 33.8385 36.0685L31.2933 34.6542C30.6268 34.2838 29.8076 34.7658 29.8076 35.5283V38.331C29.8076 38.6942 29.6107 39.0288 29.2932 39.2052L24.4856 41.8753C24.1836 42.0431 23.8164 42.0431 23.5144 41.8753L18.7078 39.2052C18.3903 39.0288 18.1934 38.6942 18.1934 38.331V35.5275C18.1934 34.7649 17.3741 34.283 16.7076 34.6534L14.1615 36.0684C13.8595 36.2363 13.4921 36.2363 13.19 36.0685L8.38342 33.3976C8.066 33.2212 7.86914 32.8866 7.86914 32.5235V27.248C7.86914 26.8849 8.06598 26.5503 8.38337 26.3739L11.394 24.7008C12.0796 24.3197 12.0796 23.3336 11.394 22.9526L8.38337 21.2794C8.06598 21.1031 7.86914 20.7685 7.86914 20.4054V15.1299C7.86914 14.7667 8.066 14.4321 8.38342 14.2557L13.1901 11.5848C13.4921 11.417 13.8594 11.417 14.1615 11.5848L16.7077 12.9994C17.3742 13.3697 18.1934 12.8877 18.1934 12.1252V9.32233C18.1934 8.95915 18.3903 8.62452 18.7078 8.44815L23.5144 5.77804C23.8164 5.61029 24.1836 5.61028 24.4856 5.77801L29.2932 8.44817ZM19.4834 20.4052C19.4834 20.7684 19.2865 21.103 18.969 21.2794L15.9573 22.9525C15.2715 23.3335 15.2715 24.3198 15.9573 24.7008L18.969 26.3739C19.2865 26.5503 19.4834 26.8849 19.4834 27.2481V30.0502C19.4834 30.8126 20.3024 31.2946 20.969 30.9243L23.5145 29.5104C23.8165 29.3427 24.1836 29.3427 24.4855 29.5103L27.0312 30.9238C27.6977 31.2939 28.5166 30.8119 28.5166 30.0495V27.248C28.5166 26.8849 28.7135 26.5503 29.0309 26.3739L32.0421 24.7008C32.7278 24.3198 32.7278 23.3336 32.042 22.9525L29.0309 21.2794C28.7135 21.1031 28.5166 20.7684 28.5166 20.4053V17.6032C28.5166 16.8407 27.6976 16.3588 27.031 16.729L24.4857 18.1428C24.1836 18.3106 23.8164 18.3106 23.5144 18.1428L20.9691 16.7284C20.3026 16.358 19.4834 16.84 19.4834 17.6025V20.4052Z"
        fill={color}
      />
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
          <div className="hexpot-tooltip-title">ROUND JACKPOT POOL</div>
          <div>
            Sponsor-funded escrow drawn each epoch. This is a game prize pool,
            not your wallet balance.
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
