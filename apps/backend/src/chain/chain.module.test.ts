import { PublicKey } from "@solana/web3.js";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";

import { ConfigModule } from "../config/config.module";
import { DEFAULT_PROGRAM_ID } from "../config/env";
import { ChainModule } from "./chain.module";
import { ChainService, SOLANA_CONNECTION } from "./chain.service";
import { poolAddress } from "./pda";

describe("ChainModule", () => {
  let chain: ChainService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ChainModule],
    })
      .overrideProvider(SOLANA_CONNECTION)
      .useValue({}) // fake connection: nothing in this ticket calls it
      .compile();

    chain = moduleRef.get(ChainService);
  });

  it("derives the Pool PDA for POOL_ID", () => {
    const expected = poolAddress(new PublicKey(DEFAULT_PROGRAM_ID), 1n);
    expect(chain.poolAddress().equals(expected)).toBe(true);
  });

  it("names an Anchor error from its program logs", () => {
    const fakeSendFailure = {
      logs: [
        "Program log: AnchorError thrown in lib.rs:100. Error Code: InvalidTileSelection. Error Number: 6000. Error Message: Invalid tile selection.",
      ],
    };
    expect(chain.mapSendError(fakeSendFailure).message).toBe(
      "InvalidTileSelection",
    );
  });
});
