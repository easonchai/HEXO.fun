import { describe, expect, it } from "vitest";

import { parseAdminCommand } from "./args";

describe("parseAdminCommand", () => {
  it("parses pause and unpause with no flags", () => {
    expect(parseAdminCommand(["pause"])).toEqual({ kind: "pause" });
    expect(parseAdminCommand(["unpause"])).toEqual({ kind: "unpause" });
  });

  it("rejects stray arguments to pause/unpause", () => {
    expect(() => parseAdminCommand(["pause", "now"])).toThrow(/unexpected argument/);
  });

  it("parses fund-jackpot's amount", () => {
    expect(parseAdminCommand(["fund-jackpot", "--amount", "50000000"])).toEqual({
      kind: "fund-jackpot",
      amount: 50_000_000n,
    });
  });

  it("rejects fund-jackpot without an amount, or a bad one", () => {
    expect(() => parseAdminCommand(["fund-jackpot"])).toThrow(/needs --amount/);
    // node:util parseArgs only accepts a "-"-leading value via "=" syntax;
    // see positiveBigInt's own check for the "-5" example without it.
    expect(() => parseAdminCommand(["fund-jackpot", "--amount=-5"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseAdminCommand(["fund-jackpot", "--amount", "1.5"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses only the set-params flags given", () => {
    expect(parseAdminCommand(["set-params", "--epoch-seconds", "900"])).toEqual({
      kind: "set-params",
      params: { epochSeconds: 900 },
    });
    expect(
      parseAdminCommand([
        "set-params",
        "--round-seconds",
        "20",
        "--close-buffer",
        "0",
      ]),
    ).toEqual({
      kind: "set-params",
      params: { roundSeconds: 20, closeBuffer: 0 },
    });
    expect(parseAdminCommand(["set-params", "--min-deposit", "0"])).toEqual({
      kind: "set-params",
      params: { minDeposit: 0n },
    });
    expect(
      parseAdminCommand(["set-params", "--house-cut-bps", "600"]),
    ).toEqual({
      kind: "set-params",
      params: { houseCutBps: 600 },
    });
  });

  it("rejects set-params with no flags at all", () => {
    expect(() => parseAdminCommand(["set-params"])).toThrow(/at least one flag/);
  });

  it("rejects out-of-range set-params values", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--epoch-seconds", "0"]),
    ).toThrow(/positive whole number/);
    expect(() =>
      parseAdminCommand(["set-params", "--close-buffer=-1"]),
    ).toThrow(/non-negative whole number/);
  });

  it("rejects a House cut rate above 10000", () => {
    expect(() =>
      parseAdminCommand(["set-params", "--house-cut-bps", "10001"]),
    ).toThrow(/0 to 10000/);
    expect(() =>
      parseAdminCommand(["set-params", "--house-cut-bps=-1"]),
    ).toThrow(/0 to 10000/);
  });

  it("rejects an unknown command", () => {
    expect(() => parseAdminCommand(["nuke-everything"])).toThrow(/usage/);
    expect(() => parseAdminCommand([])).toThrow(/usage/);
  });
});
