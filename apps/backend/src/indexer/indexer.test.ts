// Against a real Postgres, with the chain faked: the RPC responses are the
// only thing stubbed, so the Anchor coders, the row mapping and every SQL
// statement are the real ones.
//
// DATABASE_URL is set before PrismaService is constructed (the client reads it
// then, not at import), so this suite never touches the dev database.
process.env.DATABASE_URL = "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_indexer";

import { BN, BorshCoder, convertIdlToCamelCase } from "@anchor-lang/core";
import type { ConfigService } from "@nestjs/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { loadIdl } from "../chain/idl";
import { PrismaService } from "../prisma/prisma.service";
import { IndexerService, type LogBatch } from "./indexer.service";

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
const POOL_ID = 1n;
// The same coder ChainService's Program builds, available before beforeAll so
// the log fixtures can be laid out at module scope.
const coder = new BorshCoder(convertIdlToCamelCase(idl));

interface StoredAccount {
  pubkey: PublicKey;
  data: Buffer;
}

/** Only the four calls the indexer makes; everything else stays unimplemented. */
class FakeConnection {
  slot = 100;
  accounts: StoredAccount[] = [];

  getSlot(): Promise<number> {
    return Promise.resolve(this.slot);
  }

  getProgramAccounts(
    _programId: PublicKey,
    config: { filters: [{ memcmp: { offset: number; bytes: string } }] },
  ): Promise<{ pubkey: PublicKey; account: { data: Buffer } }[]> {
    const prefix = Buffer.from(bs58.decode(config.filters[0].memcmp.bytes));
    return Promise.resolve(
      this.accounts
        .filter(({ data }) => data.subarray(0, prefix.length).equals(prefix))
        .map(({ pubkey, data }) => ({ pubkey, account: { data } })),
    );
  }

  getSignaturesForAddress(): Promise<never[]> {
    return Promise.resolve([]);
  }

  onLogs(): number {
    return 1;
  }
}

let prisma: PrismaService;
let chain: ChainService;
let connection: FakeConnection;
let indexer: IndexerService;

const OWNER = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  connection = new FakeConnection();
  const env: Partial<HexVaultEnv> = {
    AUTHORITY_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
    POOL_ID: POOL_ID.toString(),
    PROGRAM_ID: PROGRAM_ID.toBase58(),
    RPC_URL: "http://127.0.0.1:1",
  };
  // SAFETY: ChainService only reads the four keys above through `get`.
  const config = {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
  // SAFETY: the fake stands in for the RPC calls listed on FakeConnection;
  // this suite drives no code path that reaches any other Connection method.
  chain = new ChainService(connection as unknown as Connection, config);
  indexer = new IndexerService(prisma, chain);
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  connection.accounts = [];
  await wipe();
});

async function wipe(): Promise<void> {
  await prisma.$transaction([
    prisma.event.deleteMany(),
    prisma.cursor.deleteMany(),
    prisma.position.deleteMany(),
    prisma.player.deleteMany(),
    prisma.round.deleteMany(),
    prisma.epoch.deleteMany(),
    prisma.pool.deleteMany(),
  ]);
}

// ------------------------------------------------------------- fixtures

const bn = (value: bigint | number): BN => new BN(value.toString());
const zeros = (length: number): number[] => new Array<number>(length).fill(0);

// The coder knows the camelCased account names, the same ones the indexer
// passes; a casing drift in Anchor breaks the encode here and the fetch there.
async function put(name: string, pubkey: PublicKey, account: object): Promise<void> {
  const data = await chain.program.coder.accounts.encode(name, account);
  connection.accounts.push({ pubkey, data });
}

const poolAccount = (overrides: object = {}) => ({
  poolId: bn(POOL_ID),
  authority: OWNER,
  acceptedMint: STRANGER,
  principalVault: chain.principalVaultAddress(),
  jackpotVault: chain.jackpotVaultAddress(),
  treasury: STRANGER,
  buybackReserve: STRANGER,
  house: chain.playerAddress(OWNER),
  vrfNetworkState: STRANGER,
  epochSeconds: bn(86_400),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(1_000),
  previousEpochStart: bn(0),
  nextRoundId: bn(2),
  openRoundId: bn(1),
  carryPot: bn(7),
  totalPrincipal: bn(3_000_000),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  ...overrides,
});

const epochAccount = (overrides: object = {}) => ({
  epochId: bn(1),
  startsAt: bn(1_000),
  endsAt: bn(2_000),
  status: 1,
  registeredWeight: bn(500),
  registeredCount: 2,
  jackpotAmount: bn(10_000_000),
  vrfSeed: zeros(32),
  requestedAt: bn(0),
  target: bn(42),
  winner: PublicKey.default,
  bump: 255,
  ...overrides,
});

const roundAccount = (overrides: object = {}) => ({
  roundId: bn(1),
  epochId: bn(1),
  startsAt: bn(1_000),
  endsAt: bn(1_060),
  status: 0,
  tileTotals: zeros(36).map((total) => bn(total)),
  pot: bn(0),
  vrfSeed: zeros(32),
  requestedAt: bn(0),
  winningTile: 0,
  bump: 255,
  ...overrides,
});

const playerAccount = (owner: PublicKey, overrides: object = {}) => ({
  owner,
  principal: bn(3_000_000),
  entries: bn(2_500_000),
  weightAcc: bn(1_234),
  lastUpdate: bn(1_500),
  epochId: bn(1),
  frozenWeight: bn(0),
  frozenEpoch: bn(0),
  regEpoch: bn(0),
  regStart: bn(0),
  regEnd: bn(0),
  isHouse: false,
  bump: 255,
  ...overrides,
});

const positionAccount = (owner: PublicKey, round: PublicKey) => ({
  owner,
  round,
  tiles: bn(0b1011),
  stakePerTile: bn(1_000),
  bump: 255,
});

describe("account sync", () => {
  it("mirrors one of each account into Postgres", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("epoch", chain.epochAddress(1n), epochAccount());
    await put("round", round, roundAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));

    await indexer.syncAccounts();

    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({
        poolId: POOL_ID,
        totalPrincipal: 3_000_000n,
        carryPot: 7n,
        currentEpochId: 1n,
        paused: false,
        updatedSlot: 100n,
      });

    const epoch = await prisma.epoch.findUniqueOrThrow({ where: { id: 1n } });
    expect(epoch.registeredWeight.toFixed(0)).toBe("500");
    // Pubkey::default means payout has not run; the column stays null.
    expect(epoch.winner).toBeNull();

    const stored = await prisma.round.findUniqueOrThrow({ where: { id: 1n } });
    // Tile 0 is a real tile, so an unsettled round must not claim it won.
    expect(stored.winningTile).toBeNull();
    expect((stored.tileTotals as string[]).length).toBe(36);

    expect(await prisma.player.findUniqueOrThrow({ where: { owner: OWNER.toBase58() } }))
      .toMatchObject({ principal: 3_000_000n, entries: 2_500_000n, isHouse: false });

    expect(await prisma.position.findMany()).toMatchObject([
      { owner: OWNER.toBase58(), roundId: 1n, tiles: 11n, stakePerTile: 1_000n, settled: false },
    ]);
  });

  it("records the winning tile once the round is settled", async () => {
    await put("round", chain.roundAddress(1n), roundAccount({ status: 2, winningTile: 17 }));
    await indexer.syncAccounts();
    expect((await prisma.round.findUniqueOrThrow({ where: { id: 1n } })).winningTile).toBe(17);
  });

  it("deletes a Position row once settle_position has closed the account", async () => {
    const round = chain.roundAddress(1n);
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);

    connection.accounts = connection.accounts.filter((account) =>
      account.pubkey.equals(round),
    );
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(0);
  });

  it("ignores an account that does not sit at this pool's PDA", async () => {
    // Same layout, different pool: the tables are keyed by owner and epoch id,
    // so a second pool's accounts would overwrite this one's.
    await put("player", Keypair.generate().publicKey, playerAccount(STRANGER));
    await put("epoch", Keypair.generate().publicKey, epochAccount({ epochId: bn(9) }));
    await indexer.syncAccounts();
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.epoch.count()).toBe(0);
  });

  it("stamps the cursor with the sync time so /status can age it", async () => {
    await indexer.tick();
    const cursor = await prisma.cursor.findUniqueOrThrow({ where: { id: 1 } });
    expect(cursor.updatedAt).not.toBeNull();
    expect(Number(cursor.updatedAt)).toBeGreaterThan(Date.now() / 1000 - 60);
  });
});

// ----------------------------------------------------------- event ingest

/** A `Program data:` log line, built through the same IDL the indexer reads. */
function dataLine(name: string, fields: object): string {
  const event = (idl.events ?? []).find((candidate) => candidate.name === name);
  if (!event) throw new Error(`event ${name} is not in the IDL`);
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  const body = coder.types.encode(camel, fields);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString("base64")}`;
}

function batch(signature: string, slot: bigint, lines: string[]): LogBatch {
  return {
    signature,
    slot,
    blockTime: 1_700_000_000n,
    logs: [
      `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
      ...lines,
      `Program ${PROGRAM_ID.toBase58()} success`,
    ],
  };
}

const deposited = dataLine("Deposited", {
  owner: OWNER,
  amount: bn(1_000_000),
  principal: bn(1_000_000),
  entries: bn(1_000_000),
});
const epochBegan = dataLine("EpochBegan", {
  epochId: bn(2),
  startsAt: bn(1_000),
  endsAt: bn(2_000),
});
const roundOpened = dataLine("RoundOpened", {
  roundId: bn(4),
  epochId: bn(2),
  startsAt: bn(1_000),
  endsAt: bn(1_060),
  carryIn: bn(0),
});

describe("event ingest", () => {
  it("stores each event once and leaves the cursor on the newest batch", async () => {
    const first = batch("sig1", 10n, [deposited, epochBegan]);
    const second = batch("sig2", 11n, [roundOpened]);
    const third = batch("sig3", 12n, [deposited]);

    expect(await indexer.ingestLogs(first)).toBe(2);
    expect(await indexer.ingestLogs(second)).toBe(1);
    // The replay a websocket reconnect or a catch-up overlap produces.
    expect(await indexer.ingestLogs(first)).toBe(0);
    // Replaying an older batch must not drag the resume point backwards.
    expect(await prisma.cursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      lastSignature: "sig2",
      lastSlot: 11n,
    });
    expect(await indexer.ingestLogs(third)).toBe(1);

    expect(await prisma.event.count()).toBe(4);
    expect(
      (await prisma.event.findMany({ orderBy: [{ slot: "asc" }, { index: "asc" }] })).map(
        (event) => [event.signature, event.index, event.name],
      ),
    ).toEqual([
      ["sig1", 0, "Deposited"],
      ["sig1", 1, "EpochBegan"],
      ["sig2", 0, "RoundOpened"],
      ["sig3", 0, "Deposited"],
    ]);

    expect(await prisma.cursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      lastSignature: "sig3",
      lastSlot: 12n,
    });
  });

  it("keeps u64 amounts exact and block time alongside the row", async () => {
    await indexer.ingestLogs(batch("sig9", 20n, [deposited]));
    const event = await prisma.event.findFirstOrThrow();
    expect(event.blockTime).toBe(1_700_000_000n);
    expect(event.data).toMatchObject({ owner: OWNER.toBase58(), amount: "1000000" });
  });

  it("advances the cursor past a transaction that emitted nothing", async () => {
    expect(await indexer.ingestLogs(batch("sig0", 5n, ["Program log: no events here"]))).toBe(0);
    expect(await prisma.cursor.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      lastSignature: "sig0",
      lastSlot: 5n,
    });
  });
});

// -------------------------------------------------------- operator reads

describe("operator queries", () => {
  const ALICE = Keypair.generate().publicKey.toBase58();
  const BOB = Keypair.generate().publicKey.toBase58();
  const CAROL = Keypair.generate().publicKey.toBase58();
  const DAVE = Keypair.generate().publicKey.toBase58();

  const player = (owner: string, overrides: object = {}) => ({
    owner,
    principal: 0n,
    entries: 0n,
    weightAcc: "0",
    lastUpdate: 1_000n,
    epochId: 5n,
    frozenWeight: "0",
    frozenEpoch: 0n,
    regEpoch: 0n,
    regStart: "0",
    regEnd: "0",
    isHouse: false,
    ...overrides,
  });

  beforeEach(async () => {
    await prisma.epoch.create({
      data: {
        id: 5n,
        startsAt: 1_000n,
        endsAt: 2_000n,
        status: 1,
        registeredWeight: "0",
        registeredCount: 0,
        jackpotAmount: 0n,
        target: "0",
      },
    });
    await prisma.player.createMany({
      data: [
        player(ALICE, { entries: 3n, weightAcc: "500", lastUpdate: 1_400n }),
        player(BOB),
        player(CAROL, { entries: 9n, regEpoch: 5n }),
        player(DAVE, { epochId: 3n, principal: 2n }),
      ],
    });
  });

  it("returns only unregistered players with a non-zero weight", async () => {
    expect((await indexer.playersToRegister(5n)).sort()).toEqual([ALICE, DAVE].sort());
  });

  it("returns nothing for an epoch it has never seen", async () => {
    expect(await indexer.playersToRegister(99n)).toEqual([]);
  });

  it("finds the round the operator may still act on", async () => {
    await prisma.round.createMany({
      data: [
        { id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, tileTotals: [] },
        { id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, tileTotals: [] },
      ],
    });
    expect(await indexer.getOpenRound()).toMatchObject({ id: 2n, status: 1 });
  });

  it("lists positions across every round that has reached a terminal status", async () => {
    await prisma.round.createMany({
      data: [
        { id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, tileTotals: [] }, // Settled
        { id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, tileTotals: [] }, // Requested: still live
        { id: 3n, epochId: 5n, startsAt: 120n, endsAt: 180n, status: 4, pot: 0n, tileTotals: [] }, // Voided
      ],
    });
    await prisma.position.createMany({
      data: [
        { address: "pos-a", owner: ALICE, roundId: 1n, tiles: 1n, stakePerTile: 1n, settled: false },
        { address: "pos-b", owner: BOB, roundId: 2n, tiles: 1n, stakePerTile: 1n, settled: false },
        { address: "pos-c", owner: CAROL, roundId: 3n, tiles: 1n, stakePerTile: 1n, settled: false },
      ],
    });
    const positions = await indexer.unsettledPositions();
    expect(positions.sort((a, b) => a.address.localeCompare(b.address))).toEqual([
      { address: "pos-a", owner: ALICE, roundId: 1n },
      { address: "pos-c", owner: CAROL, roundId: 3n },
    ]);
  });

  it("reads a single epoch and every player", async () => {
    expect(await indexer.getEpoch(5n)).toMatchObject({ id: 5n, status: 1 });
    expect(await indexer.getEpoch(6n)).toBeNull();
    expect((await indexer.getPlayers()).length).toBe(4);
  });
});
