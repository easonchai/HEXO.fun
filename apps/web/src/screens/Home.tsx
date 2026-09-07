/**
 * HOME tab: the Figma "Landing" frame. This week's prize (the epoch's
 * simulated yield, the same `/epochs/current` value WEEKLY DRAW labels
 * "Prize") as a whole-dollar hero, a DD:HH:MM:SS clock to `endsAt`, and one
 * button that jumps to the VAULT tab.
 */
import { useCallback, useEffect, useState } from "react";

import { apiBaseUrl, fetchCurrentEpoch } from "../api.js";
import { dhmsParts } from "../engine.js";
import { useApiPoll } from "../useApiPoll.js";

export interface HomeProps {
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  onDeposit: () => void;
}

/** Atomic string (6dp) → "$24,891". Whole dollars only, matching the design. */
export function wholeDollars(atomic: string): string {
  const clean = atomic.replace(/[^0-9]/g, "") || "0";
  return `$${(BigInt(clean) / 1_000_000n).toLocaleString("en-US")}`;
}

const CLOCK_LABELS = ["DAYS", "HRS", "MIN", "SEC"] as const;

/** Hand-traced from the Figma glyph row: star, square, target, cross, frame, plus. */
const GLYPHS = [
  <path d="M12 2.5l2.7 6 6.3.6-4.8 4.3 1.5 6.4L12 16.5l-5.7 3.3 1.5-6.4L3 9.1l6.3-.6z" />,
  <rect x="4" y="4" width="16" height="16" rx="4" fill="none" strokeWidth="3" />,
  <g fill="none" strokeWidth="3">
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="2" strokeWidth="2" />
  </g>,
  <path d="M5 5l14 14M19 5L5 19" fill="none" strokeWidth="3.5" />,
  <g>
    <rect x="4" y="4" width="16" height="16" rx="4" fill="none" strokeWidth="3" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </g>,
  <path d="M12 3v18M3 12h18" fill="none" strokeWidth="6" />,
];

/** How many glyphs in a row turn on each tick, and how often a tick fires. */
const GLYPHS_PER_TICK = 2;
const GLYPH_TICK_MS = 1000;
const GLYPH_TURN_DEG = 45;

/** Distinct random glyph indexes, `count` of them (capped at the row length). */
function pickGlyphs(count: number): Set<number> {
  const picks = new Set<number>();
  while (picks.size < Math.min(count, GLYPHS.length)) {
    picks.add(Math.floor(Math.random() * GLYPHS.length));
  }
  return picks;
}

function GlyphRow() {
  const [turns, setTurns] = useState(() => GLYPHS.map(() => 0));

  useEffect(() => {
    const id = setInterval(() => {
      const picks = pickGlyphs(GLYPHS_PER_TICK);
      setTurns((prev) =>
        prev.map((deg, i) =>
          picks.has(i) ? deg + (Math.random() < 0.5 ? -GLYPH_TURN_DEG : GLYPH_TURN_DEG) : deg,
        ),
      );
    }, GLYPH_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="home-glyphs" aria-hidden="true">
      {GLYPHS.map((glyph, i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="currentColor"
          stroke="currentColor"
          strokeLinecap="round"
          style={{ transform: `rotate(${turns[i]}deg)` }}
        >
          {glyph}
        </svg>
      ))}
    </span>
  );
}

const Star = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    {GLYPHS[0]}
  </svg>
);

export function Home({ now, onDeposit }: HomeProps) {
  const loadCurrentEpoch = useCallback(
    (signal: AbortSignal) => fetchCurrentEpoch(apiBaseUrl(), signal),
    [],
  );
  const epoch = useApiPoll(loadCurrentEpoch, 2000);

  const remaining =
    epoch.data && now !== null ? BigInt(epoch.data.endsAt) - now : null;
  const drawing = epoch.data?.drawing !== null && epoch.data?.drawing !== undefined;
  const parts = remaining === null ? null : dhmsParts(remaining);

  return (
    <div className="home" data-testid="home-screen">
      <div className="home-hero">
        <div className="home-pill-row">
          <Star />
          <span className="home-pill">CURRENT PRIZE POOL</span>
          <Star />
        </div>
        <div className="home-amount" data-testid="home-prize">
          {epoch.data ? wholeDollars(epoch.data.jackpotAmount) : "$—"}
        </div>
        <p className="home-tagline">
          Save your <em>money</em>, play with <em>luck</em>
        </p>
      </div>

      <div className="home-clock">
        <div className="home-clock-label">WEEKLY PRIZE DRAW · NEXT DRAW IN</div>
        {drawing || (remaining !== null && remaining <= 0n) ? (
          <div className="home-drawing" data-testid="home-drawing">
            DRAWING…
          </div>
        ) : (
          <div className="home-clock-boxes" data-testid="home-countdown">
            {CLOCK_LABELS.map((label, i) => (
              <div key={label} className="home-clock-unit">
                <div className="home-clock-box">{parts ? parts[i] : "--"}</div>
                <div className="home-clock-unit-label">{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="home-cta-row">
        <GlyphRow />
        <button
          type="button"
          className="home-cta"
          data-testid="home-deposit"
          onClick={onDeposit}
        >
          DEPOSIT NOW
        </button>
        <GlyphRow />
      </div>

      <div className="home-footer">
        <span>NO-LOSS</span>
        <Star />
        <span>WEEKLY PRIZE DRAWS</span>
        <Star />
        <span>YOUR DEPOSIT IS NEVER TOUCHED</span>
      </div>
    </div>
  );
}
