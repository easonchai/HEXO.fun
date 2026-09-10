/**
 * The self-playing board from the marketing site's hero
 * (apps/landing/index.html, `arena()`), on the app's own geo.ts. Thirteen
 * positions land 300ms apart, the laser fires, the winner holds, the board
 * resets. No engine, no chain, no timer: it is decoration that moves.
 *
 * Imperative on purpose. The marketing script drives the SVG by hand and
 * the point is to match it exactly, so this mounts the same markup once and
 * runs the same timers against it instead of re-rendering 36 tiles through
 * React every 300ms.
 */
import { useEffect, useRef } from "react";

import { computeGeo, genPath, STAGE_H, STAGE_W } from "./geo.js";

const LIME = "#B6FF3B";
const NAVY = "#0E1B2B";
const TILE_FILL = "#132133";
const TILE_STROKE = "rgba(226,228,233,.13)";
const TILE_TEXT = "#838a93";
const DOT = `<circle class="dot-plain" r="1.75" fill="rgba(182,255,59,.22)"/>`;

const PICKS = 13;
const PICK_EVERY = 300;
const FIRE_AT = PICKS * PICK_EVERY;
const CYCLE = FIRE_AT + 4800;

/** Textile.tsx's six symbols as lime strings (20x20), for innerHTML. */
const SYMBOLS = [
  `<path d="M3.5 3.5 L16.5 16.5 M16.5 3.5 L3.5 16.5" stroke="${LIME}" stroke-width="3.6" stroke-linecap="round" fill="none"/>`,
  `<circle cx="10" cy="10" r="8" fill="none" stroke="${LIME}" stroke-width="2.6"/><circle cx="10" cy="10" r="3.4" fill="${LIME}"/>`,
  `<rect x="2" y="2" width="16" height="16" rx="3.5" fill="none" stroke="${LIME}" stroke-width="2.6"/><rect x="7" y="7" width="6" height="6" rx="1.2" fill="${LIME}"/>`,
  `<rect x="2.5" y="7" width="15" height="6" rx="2.2" fill="${LIME}"/><rect x="7" y="2.5" width="6" height="15" rx="2.2" fill="${LIME}"/><circle cx="10" cy="10" r="2" fill="${NAVY}"/>`,
  `<path fill="${LIME}" fill-rule="evenodd" d="M6.5 2 h7 a4.5 4.5 0 0 1 4.5 4.5 v7 a4.5 4.5 0 0 1 -4.5 4.5 h-7 a4.5 4.5 0 0 1 -4.5 -4.5 v-7 a4.5 4.5 0 0 1 4.5 -4.5 z M10 5.6 a4.4 4.4 0 1 0 0 8.8 a4.4 4.4 0 1 0 0 -8.8 z"/>`,
  `<polygon points="10,2.4 12.35,7 17.5,7.7 13.8,11.3 14.7,16.4 10,13.9 5.3,16.4 6.2,11.3 2.5,7.7 7.65,7" fill="${LIME}" stroke="${LIME}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
];

function boardMarkup(): string {
  const geo = computeGeo();
  const tiles = geo.tiles
    .map(
      (t) => `<g transform="translate(${t.x} ${t.y})">
  <g class="tile-inner" data-tile="${t.n}">
    <rect transform="rotate(${t.rot})" x="-17" y="-17" width="34" height="34" rx="2"
      fill="${TILE_FILL}" stroke="${TILE_STROKE}" stroke-width="1.2"/>
    <text x="0" y="0" text-anchor="middle" dominant-baseline="central"
      font-family="Roboto Mono, monospace" font-size="14" font-weight="600"
      fill="${TILE_TEXT}">${t.n}</text>
  </g>
</g>`,
    )
    .join("");
  const dots = geo.dots
    .map(
      (d) =>
        `<g data-dot="${d.key}" transform="translate(${d.x} ${d.y})">${DOT}</g>`,
    )
    .join("");
  return `<polygon points="${geo.hexPts}" fill="none" stroke="rgba(226,228,233,.14)" stroke-width="1.2"/>
<g class="dots">${dots}</g>
<g class="laser"></g>
<g class="tiles">${tiles}</g>
<g class="shocks"></g>`;
}

/** Runs the pick → fire → reset loop on a mounted board. Returns a stop(). */
function play(svg: SVGSVGElement): () => void {
  const geo = computeGeo();
  const laserG = svg.querySelector<SVGGElement>(".laser")!;
  const shockG = svg.querySelector<SVGGElement>(".shocks")!;
  const dotEls = new Map(
    [...svg.querySelectorAll<SVGGElement>("[data-dot]")].map((el) => [
      el.dataset.dot!,
      el,
    ]),
  );
  const tileEls = new Map(
    [...svg.querySelectorAll<SVGGElement>("[data-tile]")].map((el) => [
      Number(el.dataset.tile),
      el,
    ]),
  );

  let timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

  const paint = (el: SVGGElement, fill: string, stroke: string, text: string) => {
    el.querySelector("rect")!.setAttribute("fill", fill);
    el.querySelector("rect")!.setAttribute("stroke", stroke);
    el.querySelector("text")!.setAttribute("fill", text);
  };

  function resetBoard() {
    laserG.innerHTML = "";
    shockG.innerHTML = "";
    dotEls.forEach((el) => {
      el.innerHTML = DOT;
    });
    tileEls.forEach((el) => {
      el.classList.remove("win", "sel");
      paint(el, TILE_FILL, TILE_STROKE, TILE_TEXT);
    });
  }

  /** A position lands on a tile. Selections only ever accumulate. */
  function select(n: number) {
    const el = tileEls.get(n);
    if (!el || el.classList.contains("sel")) return;
    el.classList.add("sel");
    paint(el, "rgba(182,255,59,.2)", LIME, LIME);
  }

  function fire() {
    const win = geo.tiles[Math.floor(Math.random() * geo.tiles.length)]!;
    const { pathD, activeDotTimes } = genPath(geo, win.x, win.y);

    laserG.innerHTML = `<path d="${pathD}" pathLength="100" fill="none" stroke="${LIME}"
        stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
      <circle r="4.5" fill="${LIME}">
        <animateMotion dur="0.9s" fill="freeze" path="${pathD}"/>
      </circle>`;

    // Each struck dot stamps its symbol as the beam passes.
    for (const [key, info] of Object.entries(activeDotTimes)) {
      const el = dotEls.get(key);
      if (!el) continue;
      el.innerHTML = `<g class="dot-sym" transform="translate(-10 -10)"
        style="animation: symbolPop .36s cubic-bezier(.17,.89,.32,1.28) forwards ${info.delay}s; opacity:0">
        ${SYMBOLS[info.sym]}</g>`;
    }

    // The tile lands, then two rings.
    at(900, () => {
      const el = tileEls.get(win.n);
      if (!el) return;
      el.classList.remove("sel");
      el.classList.add("win");
      paint(el, LIME, LIME, NAVY);
      shockG.innerHTML = `<circle class="shock" cx="${win.x}" cy="${win.y}" r="60" fill="none" stroke="${LIME}" stroke-width="3"/>
        <circle class="shock alt" cx="${win.x}" cy="${win.y}" r="60" fill="none" stroke="#FF4136" stroke-width="2"/>`;
    });

    // Symbols drain, board returns to rest.
    at(3400, () => {
      dotEls.forEach((el) => {
        const sym = el.querySelector<SVGGElement>(".dot-sym");
        if (sym) sym.style.animation = "symbolFadeOut .65s ease-in forwards";
      });
      laserG.innerHTML = "";
    });
    at(4300, resetBoard);
  }

  function cycle() {
    const order = geo.tiles.map((t) => t.n).sort(() => Math.random() - 0.5);
    for (let i = 0; i < PICKS; i += 1) at(i * PICK_EVERY, () => select(order[i]!));
    at(FIRE_AT, fire);
  }

  function start(delay: number) {
    at(delay, function loop() {
      cycle();
      timers.push(setTimeout(loop, CYCLE));
    });
  }

  const stop = () => {
    timers.forEach(clearTimeout);
    timers = [];
    resetBoard();
  };

  start(700);

  // Stop when off-screen so the tab stays cheap.
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      if (!entry.isIntersecting) stop();
      else if (!timers.length) start(400);
    },
    { threshold: 0 },
  );
  observer.observe(svg);

  return () => {
    observer.disconnect();
    stop();
  };
}

export function DemoBoard({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.innerHTML = boardMarkup();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    return play(svg);
  }, []);

  return (
    <svg
      ref={ref}
      className={className}
      viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
      fill="none"
      aria-hidden="true"
      data-testid="demo-board"
    />
  );
}
