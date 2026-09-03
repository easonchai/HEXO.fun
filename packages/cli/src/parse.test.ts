import { describe, expect, it } from "vitest";

import {
  fmtAmount,
  fmtTiles,
  hex,
  parseAmount,
  parseHash,
  parseI64,
  parseTiles,
  parseTime,
} from "./parse.js";

describe("parseTiles", () => {
  it("builds a u64 bitmask from a tile list", () => {
    expect(parseTiles("1,7,22")).toBe((1n << 1n) | (1n << 7n) | (1n << 22n));
    expect(parseTiles("0")).toBe(1n);
    expect(parseTiles("35")).toBe(1n << 35n);
  });

  it("ignores whitespace and duplicate tiles", () => {
    expect(parseTiles(" 3, 3 , 5 ")).toBe((1n << 3n) | (1n << 5n));
  });

  it("accepts a raw mask", () => {
    expect(parseTiles("0b1011")).toBe(11n);
    expect(parseTiles("0xf")).toBe(15n);
  });

  it("rejects empty, out of range and malformed input", () => {
    expect(() => parseTiles("")).toThrow();
    expect(() => parseTiles("36")).toThrow(/range/);
    expect(() => parseTiles("-1")).toThrow();
    expect(() => parseTiles("1,,2")).toThrow();
    expect(() => parseTiles("1,x")).toThrow();
    expect(() => parseTiles("0x0")).toThrow(/mask/);
  });
});

describe("fmtTiles", () => {
  it("round trips the list form", () => {
    const mask = parseTiles("1,7,22");
    expect(fmtTiles(mask)).toBe("1,7,22");
    expect(parseTiles(fmtTiles(parseTiles("0,35")))).toBe(parseTiles("0,35"));
    expect(fmtTiles(0n)).toBe("");
  });
});

describe("parseTime", () => {
  const now = 1_000_000;

  it("parses relative seconds, minutes, hours and days", () => {
    expect(parseTime("+60s", now)).toBe(1_000_060n);
    expect(parseTime("60s", now)).toBe(1_000_060n);
    expect(parseTime("-5m", now)).toBe(999_700n);
    expect(parseTime("+2h", now)).toBe(1_000_000n + 7_200n);
    expect(parseTime("+1d", now)).toBe(1_000_000n + 86_400n);
  });

  it("parses absolute unix seconds", () => {
    expect(parseTime("1234567890", now)).toBe(1_234_567_890n);
  });

  it("rejects junk", () => {
    expect(() => parseTime("soon", now)).toThrow();
    expect(() => parseTime("1.5h", now)).toThrow();
    expect(() => parseTime("+60", now)).toThrow();
  });
});

describe("amounts", () => {
  it("parses atomic units as bigint only", () => {
    expect(parseAmount("1000000")).toBe(1_000_000n);
    expect(parseAmount("0")).toBe(0n);
    expect(() => parseAmount("1.5")).toThrow();
    expect(() => parseAmount("-1")).toThrow();
    expect(() => parseAmount("abc")).toThrow();
    expect(() => parseAmount((2n ** 64n).toString())).toThrow(/u64/);
  });

  it("formats with pool decimals", () => {
    expect(fmtAmount(1000000n, 6)).toBe("1.000000");
    expect(fmtAmount(1500000n, 6)).toBe("1.500000");
    expect(fmtAmount(1n, 0)).toBe("1");
    expect(fmtAmount(0n, 6)).toBe("0.000000");
  });

  it("parses i64 seconds", () => {
    expect(parseI64("3600")).toBe(3600n);
    expect(() => parseI64((2n ** 63n).toString())).toThrow(/i64/);
  });
});

describe("parseHash", () => {
  it("accepts 32-byte hex with or without 0x", () => {
    const root = "ab".repeat(32);
    expect(hex(parseHash(`0x${root}`))).toBe(root);
    expect(hex(parseHash(root))).toBe(root);
    expect(() => parseHash("abcd")).toThrow();
    expect(() => parseHash("zz".repeat(32))).toThrow();
  });
});
