import { Program } from "@anchor-lang/core";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { programIdFrom } from "./chain.js";
import { idl } from "./idl.js";

const DEV_ADDRESS = idl.address as string;
// Ticket 06's staging program id: any valid pubkey distinct from the dev one.
const OTHER_ADDRESS = "H2iWyng2orJpHNGGWhrR7rBQNDqixThpTpAwF4dnPXax";

describe("programIdFrom", () => {
  it("falls back to the IDL address in dev when VITE_PROGRAM_ID is unset", () => {
    expect(programIdFrom(undefined, DEV_ADDRESS, false).toBase58()).toBe(
      DEV_ADDRESS,
    );
  });

  it("throws in a production build when VITE_PROGRAM_ID is unset", () => {
    expect(() => programIdFrom(undefined, DEV_ADDRESS, true)).toThrow(
      /VITE_PROGRAM_ID/,
    );
  });

  it("VITE_PROGRAM_ID wins over the IDL address, dev or prod", () => {
    expect(programIdFrom(OTHER_ADDRESS, DEV_ADDRESS, false).toBase58()).toBe(
      OTHER_ADDRESS,
    );
    expect(programIdFrom(OTHER_ADDRESS, DEV_ADDRESS, true).toBase58()).toBe(
      OTHER_ADDRESS,
    );
  });
});

describe("App.tsx's Program address override", () => {
  it("the built Program's programId equals VITE_PROGRAM_ID when set, not the IDL's baked-in address", () => {
    const programId = programIdFrom(OTHER_ADDRESS, DEV_ADDRESS, false);
    const provider = { connection: new Connection("http://127.0.0.1:8899") };
    const program = new Program(
      { ...idl, address: programId.toBase58() },
      provider,
    );
    expect(program.programId.equals(programId)).toBe(true);
    expect(program.programId.equals(new PublicKey(DEV_ADDRESS))).toBe(false);
  });
});
