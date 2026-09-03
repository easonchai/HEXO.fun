import { PublicKey } from "@solana/web3.js";

import { usage } from "./errors.js";

export const TILE_COUNT = 36n;
export const TILE_MASK = (1n << TILE_COUNT) - 1n;

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** Money and ids are bigint; atomic units only, never floats. */
export function parseAmount(raw: string, name = "amount"): bigint {
  const s = raw.trim();
  if (!/^\d+$/.test(s))
    throw usage(`${name} must be a non-negative integer, got "${raw}"`);
  const v = BigInt(s);
  if (v > U64_MAX) throw usage(`${name} must fit u64: ${raw}`);
  return v;
}

/** Epoch/round timings are i64 on the program; CLI accepts non-negative seconds. */
export function parseI64(raw: string, name = "value"): bigint {
  const v = parseAmount(raw, name);
  if (v > I64_MAX) throw usage(`${name} out of i64 range: ${raw}`);
  return v;
}

/**
 * Absolute unix seconds, or relative to now: `+60s`, `-5m`, `+2h`, `+1d`
 * (a bare `60s` is treated as `+60s`).
 */
export function parseTime(raw: string, nowSec: number): bigint {
  const s = raw.trim();
  const m = /^([+-]?\d+)([smhd])$/.exec(s);
  if (m) {
    const mult: Record<string, bigint> = { s: 1n, m: 60n, h: 3600n, d: 86400n };
    const value = BigInt(nowSec) + BigInt(m[1]!) * mult[m[2]!]!;
    if (value < 0n || value > I64_MAX) throw usage(`time out of range: ${raw}`);
    return value;
  }
  if (/^-?\d+$/.test(s)) {
    const v = BigInt(s);
    if (v < 0n || v > I64_MAX) throw usage(`time out of range: ${raw}`);
    return v;
  }
  throw usage(`invalid time "${raw}": use unix seconds or [+|-]<n>{s|m|h|d}`);
}

/**
 * "1,7,22" -> u64 bitmask. A bare number is a single tile index; use an
 * explicit `0x`/`0b` prefix for a raw mask.
 */
export function parseTiles(spec: string): bigint {
  const s = spec.trim();
  const hexMask = /^0x([0-9a-fA-F]{1,16})$/.exec(s);
  const binMask = /^0b([01]{1,64})$/.exec(s);
  if (hexMask || binMask) {
    const mask = hexMask ? BigInt(hexMask[0]) : BigInt(`0b${binMask![1]}`);
    if (mask === 0n || (mask & ~TILE_MASK) !== 0n) {
      throw usage(`tile mask must be in 1..2^36-1, got ${s}`);
    }
    return mask;
  }
  let mask = 0n;
  for (const t of s.split(",")) {
    const tile = t.trim();
    if (!/^\d+$/.test(tile)) throw usage(`invalid tile "${tile}" in "${spec}"`);
    const idx = BigInt(tile);
    if (idx >= TILE_COUNT)
      throw usage(`tile ${tile} out of range 0..35 in "${spec}"`);
    mask |= 1n << idx;
  }
  if (mask === 0n) throw usage(`at least one tile is required in "${spec}"`);
  return mask;
}

/** Inverse of parseTiles list form: 0b1010 -> "1,3". */
export function fmtTiles(mask: bigint): string {
  const out: string[] = [];
  for (let i = 0n; i < TILE_COUNT; i += 1n) {
    if ((mask & (1n << i)) !== 0n) out.push(i.toString());
  }
  return out.join(",");
}

export function fmtAmount(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  if (decimals === 0) return `${neg ? "-" : ""}${whole}`;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function parsePubkey(raw: string, name = "pubkey"): PublicKey {
  try {
    return new PublicKey(raw.trim());
  } catch {
    throw usage(`invalid ${name}: ${raw}`);
  }
}

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** 0x-prefixed 32-byte hex into Uint8Array(32). */
export function parseHash(raw: string, name = "root"): Uint8Array {
  const s = raw.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw usage(`${name} must be 32-byte hex`);
  return Uint8Array.from(Buffer.from(s, "hex"));
}
