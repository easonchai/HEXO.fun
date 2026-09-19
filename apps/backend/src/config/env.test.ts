// The boot contract: what a missing var says, and that the mint rename does
// not strand a deployment still holding the old name (ticket 03).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { DEFAULT_OPERATOR_SOL_WARN, validateEnv } from "./env";

const MINT = Keypair.generate().publicKey.toBase58();

const base = {
  DATABASE_URL: "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault",
  RPC_URL: "http://127.0.0.1:8899",
  OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
  CORS_ORIGIN: "http://localhost:5173",
};

describe("validateEnv", () => {
  it("takes the mint under its new name", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).ACCEPTED_MINT).toBe(MINT);
  });

  it("still takes it under the old HEXUSDC_MINT", () => {
    expect(validateEnv({ ...base, HEXUSDC_MINT: MINT }).ACCEPTED_MINT).toBe(MINT);
  });

  it("prefers the new name when a deployment carries both", () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, HEXUSDC_MINT: other }).ACCEPTED_MINT,
    ).toBe(MINT);
  });

  it("names the mint by its new name when neither is set", () => {
    expect(() => validateEnv(base)).toThrow(/ACCEPTED_MINT/);
  });

  it("defaults the operator SOL warning", () => {
    expect(validateEnv({ ...base, ACCEPTED_MINT: MINT }).OPERATOR_SOL_WARN).toBe(
      DEFAULT_OPERATOR_SOL_WARN,
    );
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "1.5" })
        .OPERATOR_SOL_WARN,
    ).toBe(1.5);
  });

  it("takes a blank operator SOL warning as unset", () => {
    // How a compose file spells "leave this one alone".
    expect(
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "   " })
        .OPERATOR_SOL_WARN,
    ).toBe(DEFAULT_OPERATOR_SOL_WARN);
  });

  it("fails the boot on an operator SOL warning that is not a number", () => {
    // Number("0.3 SOL") is NaN, and a NaN threshold would report the
    // operator's balance as healthy for the life of the process.
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "0.3 SOL" }),
    ).toThrow(/OPERATOR_SOL_WARN/);
    expect(() =>
      validateEnv({ ...base, ACCEPTED_MINT: MINT, OPERATOR_SOL_WARN: "-1" }),
    ).toThrow(/OPERATOR_SOL_WARN/);
  });
});
