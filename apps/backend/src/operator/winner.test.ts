// Step 4 picks the winner in Postgres, not on chain, and it compares a u128
// target against two Decimal(40,0) columns. That comparison is worth a real
// database: a silent string/Decimal mismatch here pays the wrong player.
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainModule } from "../chain/chain.module";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { OperatorModule } from "./operator.module";
import { OperatorService } from "./operator.service";

// PrismaClient reads DATABASE_URL when it is constructed, which happens below
// rather than at import time, so overriding the setup file's default here is
// still early enough.
process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

const OWNERS = ["winner-test-a", "winner-test-b", "winner-test-c"];

const player = (owner: string, regStart: string, regEnd: string) => ({
  owner,
  principal: 0n,
  entries: 0n,
  weightAcc: "0",
  lastUpdate: 0n,
  epochId: 7n,
  frozenWeight: "0",
  frozenEpoch: 0n,
  regEpoch: 7n,
  regStart,
  regEnd,
  isHouse: false,
});

describe("winner lookup", () => {
  let prisma: PrismaService;
  let operator: OperatorService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Not initialised: `compile()` wires the graph without starting the
      // scheduler, so no tick runs against whatever is on the RPC port.
      imports: [ConfigModule, PrismaModule, ChainModule, OperatorModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    operator = moduleRef.get(OperatorService);

    await prisma.player.deleteMany({ where: { owner: { in: OWNERS } } });
    await prisma.player.createMany({
      data: [
        // A weight far past 2^64, where a naive number comparison would fail.
        player(OWNERS[0] as string, "0", "40000000000000000000"),
        player(OWNERS[1] as string, "40000000000000000000", "80000000000000000000"),
        { ...player(OWNERS[2] as string, "0", "80000000000000000000"), regEpoch: 6n },
      ],
    });
  });

  afterAll(async () => {
    await prisma.player.deleteMany({ where: { owner: { in: OWNERS } } });
    await prisma.$disconnect();
  });

  // The query is private plumbing; reaching it directly beats standing up a
  // whole tick just to observe which row it picks.
  const winner = (epochId: bigint, target: bigint): Promise<string | null> =>
    (operator as unknown as {
      winner(epochId: bigint, target: bigint): Promise<string | null>;
    }).winner(epochId, target);

  it("picks the interval that contains the target", async () => {
    expect(await winner(7n, 0n)).toBe(OWNERS[0]);
    expect(await winner(7n, 39_999_999_999_999_999_999n)).toBe(OWNERS[0]);
    expect(await winner(7n, 40_000_000_000_000_000_000n)).toBe(OWNERS[1]);
  });

  it("ignores players registered for another epoch, and targets nobody holds", async () => {
    expect(await winner(6n, 0n)).toBe(OWNERS[2]);
    expect(await winner(7n, 80_000_000_000_000_000_000n)).toBeNull();
  });
});
