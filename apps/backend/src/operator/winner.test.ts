// Step 4 picks the winner in Postgres, not on chain, and it compares a u128
// target against two Decimal(40,0) columns. That comparison is worth a real
// database: a silent string/Decimal mismatch here pays the wrong player.
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainModule } from "../chain/chain.module";
import { ChainService } from "../chain/chain.service";
import { ConfigModule } from "../config/config.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { isDatabaseReachableSync } from "../test-utils/db-probe";
import { OperatorModule } from "./operator.module";
import { OperatorService } from "./operator.service";
import { ensurePoolRow } from "./pool-row.fixture";

// PrismaClient reads DATABASE_URL when it is constructed, which happens below
// rather than at import time, so overriding the setup file's default here is
// still early enough.
const TEST_DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";
process.env.DATABASE_URL = TEST_DATABASE_URL;

const DB_AVAILABLE = isDatabaseReachableSync(TEST_DATABASE_URL);

const OWNERS = ["winner-test-a", "winner-test-b", "winner-test-c"];
const RETIRED_OWNER = "winner-test-retired";
const RETIRED_POOL_ID = 99n;

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
  pendingWithdraw: 0n,
  pendingEpoch: 0n,
  principalAcc: "0",
  frozenPrincipalAcc: "0",
  yieldEpoch: 0n,
  boughtEpoch: 0n,
  boughtAmount: 0n,
  bonusEpoch: 0n,
  bonusGranted: 0n,
});

describe.skipIf(!DB_AVAILABLE)("winner lookup", () => {
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
    const chain = moduleRef.get(ChainService);
    const active = chain.poolAddress().toBase58();
    const retired = chain.poolAddress(RETIRED_POOL_ID).toBase58();
    await ensurePoolRow(prisma, active, chain.poolId);
    await ensurePoolRow(prisma, retired, RETIRED_POOL_ID);

    await prisma.player.deleteMany({ where: { owner: { in: [...OWNERS, RETIRED_OWNER] } } });
    await prisma.player.createMany({
      data: [
        // A weight far past 2^64, where a naive number comparison would fail.
        { ...player(OWNERS[0] as string, "0", "40000000000000000000"), poolAddress: active },
        {
          ...player(OWNERS[1] as string, "40000000000000000000", "80000000000000000000"),
          poolAddress: active,
        },
        {
          ...player(OWNERS[2] as string, "0", "80000000000000000000"),
          regEpoch: 6n,
          poolAddress: active,
        },
        // Same epoch id and interval in a retired pool (ADR 0016): epoch 7
        // there is a different Draw, so it must never win this one.
        {
          ...player(RETIRED_OWNER, "80000000000000000000", "90000000000000000000"),
          poolAddress: retired,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.player.deleteMany({ where: { owner: { in: [...OWNERS, RETIRED_OWNER] } } });
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
    // Held by RETIRED_OWNER, but only in the retired pool.
    expect(await winner(7n, 80_000_000_000_000_000_000n)).toBeNull();
  });
});
