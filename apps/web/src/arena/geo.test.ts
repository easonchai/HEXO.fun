import { describe, expect, it } from "vitest";

import {
  buildFlyTokens,
  computeGeo,
  genPath,
  lastFlyArrivalMs,
} from "./geo.js";

const geo = computeGeo();

/** Small deterministic LCG so path walks replay identically. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe("arena geometry", () => {
  it("lays out 36 numbered tiles around six edges", () => {
    expect(geo.tiles).toHaveLength(36);
    expect(geo.tiles.map((tile) => tile.n)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1),
    );
    // Tiles ride the edges of the hexagon: apothem (R·cos30°) ≤ r ≤ R.
    for (const tile of geo.tiles) {
      const r = Math.hypot(tile.x - geo.cx, tile.y - geo.cy);
      expect(r).toBeGreaterThanOrEqual(229);
      expect(r).toBeLessThanOrEqual(266);
    }
  });

  it("keeps tiles from overlapping each other", () => {
    for (let i = 0; i < geo.tiles.length; i += 1) {
      for (let j = i + 1; j < geo.tiles.length; j += 1) {
        const a = geo.tiles[i]!;
        const b = geo.tiles[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(21);
      }
    }
  });

  it("builds a dot lattice strictly inside the inner hexagon", () => {
    expect(geo.dots.length).toBeGreaterThan(50);
    for (const dot of geo.dots) {
      const r = Math.hypot(dot.x - geo.cx, dot.y - geo.cy);
      expect(r).toBeLessThan(265 - 52 + 1);
    }
  });

  it("routes the laser from center to every tile with a valid path", () => {
    for (const tile of geo.tiles) {
      const { pathD, activeDotTimes } = genPath(
        geo,
        tile.x,
        tile.y,
        rng(tile.n),
      );
      expect(pathD.startsWith(`M${geo.cx} ${geo.cy} L`)).toBe(true);
      // Path terminates at the target tile.
      const tail = pathD.slice(-12);
      expect(tail).toContain(String(Math.round(tile.x)));
      // Touched dots are lattice members only (never the tile itself).
      const lattice = new Set(geo.dots.map((dot) => dot.key));
      for (const key of Object.keys(activeDotTimes)) {
        expect(lattice.has(key)).toBe(true);
      }
      // Delays are monotonically reachable within the 0.9s travel window.
      const delays = Object.values(activeDotTimes).map((info) => info.delay);
      expect(Math.max(...delays, 0)).toBeLessThan(0.9);
    }
  });

  it("flies one token per touched dot plus the winner, in strike order", () => {
    const tile = geo.tiles[18]!;
    const { activeDotTimes } = genPath(geo, tile.x, tile.y, rng(7));
    const tokens = buildFlyTokens(activeDotTimes, tile, rng(11));
    expect(tokens.length).toBe(Object.keys(activeDotTimes).length + 1);
    for (let i = 1; i < tokens.length; i += 1) {
      expect(tokens[i]!.delay).toBeGreaterThan(tokens[i - 1]!.delay);
    }
    // Every arc terminates at the hexpot anchor.
    for (const token of tokens) {
      expect(token.pathD.endsWith(`310 615`)).toBe(true);
    }
    expect(lastFlyArrivalMs(tokens)).toBeGreaterThan(0);
  });
});
