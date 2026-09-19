import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { atomicUsdc, parseAdminCommand } from "./args";

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

  it("parses the three flags ticket 10 added to the program", () => {
    expect(
      parseAdminCommand([
        "set-params",
        "--min-jackpot",
        "42",
        "--registration-window",
        "600",
        "--payout-timeout",
        "86400",
      ]),
    ).toEqual({
      kind: "set-params",
      params: {
        minJackpot: 42_000_000n,
        registrationWindow: 600,
        payoutTimeout: 86_400,
      },
    });
  });

  it("rejects a registration window at or past the epoch it is given with", () => {
    expect(() =>
      parseAdminCommand([
        "set-params",
        "--epoch-seconds",
        "600",
        "--registration-window",
        "600",
      ]),
    ).toThrow(/must be under the 600s epoch/);
    expect(() => parseAdminCommand(["set-params", "--payout-timeout", "0"])).toThrow(
      /positive whole number/,
    );
  });

  it("parses withdraw-principal's amount as typed, decimals and all", () => {
    expect(parseAdminCommand(["withdraw-principal", "--amount", "250"])).toEqual({
      kind: "withdraw-principal",
      amount: "250",
    });
    expect(parseAdminCommand(["withdraw-principal", "--amount", "12.5"])).toEqual({
      kind: "withdraw-principal",
      amount: "12.5",
    });
  });

  it("rejects a withdraw-principal amount that is zero, negative or too precise", () => {
    expect(() => parseAdminCommand(["withdraw-principal"])).toThrow(/needs --amount/);
    expect(() => parseAdminCommand(["withdraw-principal", "--amount", "0"])).toThrow(
      /positive amount of USDC/,
    );
    expect(() => parseAdminCommand(["withdraw-principal", "--amount", "0.000"])).toThrow(
      /positive amount of USDC/,
    );
    expect(() => parseAdminCommand(["withdraw-principal", "--amount=-5"])).toThrow(
      /positive amount of USDC/,
    );
    expect(() =>
      parseAdminCommand(["withdraw-principal", "--amount", "1.1234567"]),
    ).toThrow(/positive amount of USDC/);
  });

  it("parses the two key commands and accept-admin", () => {
    const key = Keypair.generate().publicKey;
    expect(parseAdminCommand(["set-operator", "--key", key.toBase58()])).toEqual({
      kind: "set-operator",
      key,
    });
    expect(parseAdminCommand(["propose-admin", "--key", key.toBase58()])).toEqual({
      kind: "propose-admin",
      key,
    });
    expect(parseAdminCommand(["accept-admin"])).toEqual({ kind: "accept-admin" });
    expect(() => parseAdminCommand(["set-operator"])).toThrow(/needs --key/);
    expect(() => parseAdminCommand(["propose-admin", "--key", "nope"])).toThrow(
      /base58 pubkey/,
    );
    expect(() => parseAdminCommand(["accept-admin", "now"])).toThrow(
      /unexpected argument/,
    );
  });

  it("scales a USDC amount by the mint's decimals", () => {
    expect(atomicUsdc("250", 6)).toBe(250_000_000n);
    expect(atomicUsdc("12.5", 6)).toBe(12_500_000n);
    expect(atomicUsdc("0.000001", 6)).toBe(1n);
    expect(atomicUsdc("1.5", 9)).toBe(1_500_000_000n);
    expect(() => atomicUsdc("1.5", 0)).toThrow(/more decimal places/);
  });

  it("rejects an unknown command", () => {
    expect(() => parseAdminCommand(["nuke-everything"])).toThrow(/usage/);
    expect(() => parseAdminCommand([])).toThrow(/usage/);
  });
});
