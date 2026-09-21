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
import { CountingConnection } from "../test-utils/counting-connection";
import { IndexerService, type LogBatch } from "./indexer.service";

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
const POOL_ID = 1n;
// The same coder ChainService's Program builds, available before beforeAll so
// the log fixtures can be laid out at module scope.
const coder = new BorshCoder(convertIdlToCamelCase(idl));

let prisma: PrismaService;
let chain: ChainService;
let connection: CountingConnection;
let indexer: IndexerService;

const OWNER = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  connection = new CountingConnection();
  const env: Partial<HexVaultEnv> = {
    OPERATOR_KEYPAIR: bs58.encode(Keypair.generate().secretKey),
    POOL_ID: POOL_ID.toString(),
    PROGRAM_ID: PROGRAM_ID.toBase58(),
    RPC_URL: "http://127.0.0.1:1",
  };
  // SAFETY: ChainService only reads the four keys above through `get`.
  const config = {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
  // SAFETY: the fake stands in for the RPC calls the indexer makes; this
  // suite drives no code path that reaches any other Connection method.
  chain = new ChainService(connection as unknown as Connection, config);
  indexer = new IndexerService(prisma, chain);
});

afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

beforeEach(async () => {
  connection.clearAccounts();
  connection.pageSize = 1_000;
  connection.watched = [];
  connection.resetCalls();
  connection.failOnCallNumber = undefined;
  connection.noProgramAccountsV2 = false;
  // The indexer is built once for the suite, so the flag it latches when an
  // RPC lacks V2 has to be cleared between tests, and so does what the live
  // path has written (a fresh process starts with neither).
  indexer["v2Unsupported"] = false;
  indexer["freshWrites"].clear();
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
  connection.setAccount(pubkey, data);
}

const poolAccount = (overrides: object = {}) => ({
  poolId: bn(POOL_ID),
  admin: OWNER,
  operator: OWNER,
  pendingAdmin: PublicKey.default,
  acceptedMint: STRANGER,
  principalVault: chain.principalVaultAddress(),
  jackpotVault: chain.jackpotVaultAddress(),
  treasury: STRANGER,
  buybackReserve: STRANGER,
  house: chain.playerAddress(OWNER),
  vrfNetworkState: STRANGER,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(1_000),
  currentEpochEndsAt: bn(2_000),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  nextRoundId: bn(2),
  openRoundId: bn(1),
  carryPot: bn(7),
  totalPrincipal: bn(3_000_000),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
  pendingWithdrawals: bn(0),
  minJackpot: bn(1_000_000),
  registrationWindow: bn(0),
  payoutTimeout: bn(86_400),
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
  pendingWithdraw: bn(0),
  pendingEpoch: bn(0),
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
      { owner: OWNER.toBase58(), roundId: 1n, tiles: 11n, stakePerTile: 1_000n },
    ]);
  });

  it("records the winning tile once the round is settled", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", chain.roundAddress(1n), roundAccount({ status: 2, winningTile: 17 }));
    await indexer.syncAccounts();
    expect((await prisma.round.findUniqueOrThrow({ where: { id: 1n } })).winningTile).toBe(17);
  });

  it("no longer deletes a Position by its absence from a sweep", async () => {
    // A closed account and an unchanged one both look like "not returned" to
    // an incremental walk, so a sweep can no longer tell them apart; only the
    // `PositionSettled` event (see "event ingest" below) may remove the row.
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    const pool = chain.poolAddress();
    await put("pool", pool, poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);

    connection.deleteAccount(chain.positionAddress(round, OWNER));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);
  });

  it("walks every page of a multi-page result into the same rows a single page would", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    connection.pageSize = 1; // four accounts, one per page: four calls

    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(4);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({ poolId: POOL_ID });
    expect(await prisma.round.findUniqueOrThrow({ where: { id: 1n } })).toMatchObject({ id: 1n });
    expect(await prisma.player.findUniqueOrThrow({ where: { owner: OWNER.toBase58() } }))
      .toMatchObject({ owner: OWNER.toBase58() });
    expect(await prisma.position.findMany()).toMatchObject([
      { owner: OWNER.toBase58(), roundId: 1n },
    ]);
  });

  it("an incremental sweep asks for changedSinceSlot and only touches the rows the RPC reports", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts(); // full walk, establishes lastSyncedSlot
    const syncedSlot = indexer["lastSyncedSlot"];
    if (typeof syncedSlot !== "bigint") throw new Error("expected lastSyncedSlot to be set by the full walk above");
    expect(syncedSlot).toBe(100n);

    connection.resetCalls();
    // Simulate the RPC reporting only the Pool as changed; Round and Position
    // are unchanged and so absent from this result.
    connection.clearAccounts();
    await put("pool", chain.poolAddress(), poolAccount({ carryPot: bn(999) }));
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
    // SAFETY: the fake only ever receives [programId, config] from the indexer.
    const [, config] = connection.lastParams("getProgramAccountsV2") as [string, { changedSinceSlot?: number }];
    expect(config.changedSinceSlot).toBe(Number(syncedSlot));

    expect((await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } })).carryPot)
      .toBe(999n);
    // The old absence-based delete would have wiped these; they must survive.
    expect(await prisma.round.count()).toBe(1);
    expect(await prisma.position.count()).toBe(1);
  });

  it("forces a fresh full walk once the safety interval has elapsed, even with a known slot", async () => {
    indexer["lastSyncedSlot"] = 42n;
    indexer["lastFullWalkAt"] = Date.now() - (60 * 60 * 1000 + 1);
    await put("pool", chain.poolAddress(), poolAccount());
    connection.resetCalls();

    await indexer.syncAccounts();

    // SAFETY: the fake only ever receives [programId, config] from the indexer.
    const [, config] = connection.lastParams("getProgramAccountsV2") as [string, { changedSinceSlot?: number }];
    expect(config.changedSinceSlot).toBeUndefined();
  });

  it("a page failure mid-walk leaves the previous synced state and slot intact", async () => {
    indexer["lastSyncedSlot"] = undefined;
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.syncAccounts();
    const syncedSlot = indexer["lastSyncedSlot"];

    connection.pageSize = 1;
    connection.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));
    connection.resetCalls(); // count fresh from this walk's first page
    connection.failOnCallNumber = { method: "getProgramAccountsV2", number: 2 }; // the walk's second page

    await expect(indexer.syncAccounts()).rejects.toThrow();

    expect(indexer["lastSyncedSlot"]).toBe(syncedSlot);
    expect(await prisma.pool.findUniqueOrThrow({ where: { address: chain.poolAddress().toBase58() } }))
      .toMatchObject({ poolId: POOL_ID });
  });

  it("the counting connection: seven calls for a full walk, one for a quiet incremental sweep", async () => {
    indexer["lastSyncedSlot"] = undefined;
    indexer["lastFullWalkAt"] = 0;
    await put("pool", chain.poolAddress(), poolAccount());
    // Padding so the walk spans seven one-account pages; the padding never
    // matches a real discriminator, so it is silently dropped, same as any
    // account from an abandoned program build.
    for (let i = 0; i < 6; i++) {
      connection.setAccount(Keypair.generate().publicKey, Buffer.alloc(8));
    }
    connection.pageSize = 1;
    connection.resetCalls();

    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(7);

    connection.resetCalls();
    connection.clearAccounts();
    await indexer.syncAccounts();
    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
  });

  it("falls back to the plain call on an RPC without getProgramAccountsV2, and stops asking for it", async () => {
    indexer["lastSyncedSlot"] = undefined;
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    connection.noProgramAccountsV2 = true;
    connection.resetCalls();

    await indexer.syncAccounts();

    // One V2 attempt, then the plain call answers with the same rows.
    expect(connection.callsTo("getProgramAccountsV2")).toBe(1);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.round.count()).toBe(1);
    expect(await prisma.position.findMany()).toMatchObject([{ owner: OWNER.toBase58(), roundId: 1n }]);

    // A second sweep does not retry V2, and without changedSinceSlot it walks
    // everything again, so a closed Position is still caught by its absence.
    connection.resetCalls();
    connection.deleteAccount(chain.positionAddress(round, OWNER));
    await indexer.syncAccounts();

    expect(connection.callsTo("getProgramAccountsV2")).toBe(0);
    expect(connection.callsTo("getProgramAccounts")).toBe(1);
    expect(await prisma.position.count()).toBe(0);
  });

  it("ignores an account that does not sit at this pool's PDA", async () => {
    // Same layout, different pool: the tables are keyed by owner and epoch id,
    // so a second pool's accounts would overwrite this one's.
    await put("pool", chain.poolAddress(), poolAccount());
    await put("player", Keypair.generate().publicKey, playerAccount(STRANGER));
    await put("epoch", Keypair.generate().publicKey, epochAccount({ epochId: bn(9) }));
    await indexer.syncAccounts();
    expect(await prisma.player.count()).toBe(0);
    expect(await prisma.epoch.count()).toBe(0);
  });

  it("skips a pool left behind by an older program layout and still syncs this one", async () => {
    // A pool bootstrapped before the epoch-anchor upgrade is 22 bytes short
    // of the current layout; decoding it must not fail the whole sweep.
    const stale = await chain.program.coder.accounts.encode("pool", poolAccount());
    connection.setAccount(Keypair.generate().publicKey, stale.subarray(0, -22));
    await put("pool", chain.poolAddress(), poolAccount());
    await indexer.syncAccounts();
    expect(await prisma.pool.count()).toBe(1);
  });

  it("stamps the cursor with the sync time so /status can age it", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
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
const positionSettled = dataLine("PositionSettled", {
  roundId: bn(1),
  owner: OWNER,
  reward: bn(0),
});

describe("event ingest", () => {
  it("deletes the Position row when PositionSettled lands, without a sweep", async () => {
    await prisma.position.create({
      data: { address: "pos-x", owner: OWNER.toBase58(), roundId: 1n, tiles: 1n, stakePerTile: 1n },
    });

    expect(await indexer.ingestLogs(batch("sig-settle", 30n, [positionSettled]))).toBe(1);

    expect(await prisma.position.count()).toBe(0);
  });


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

  // Several pools share one program on devnet and events carry no pool field,
  // so listening on the program id fed every sibling pool's feed into this one.
  it("lists and subscribes on the pool PDA, never the program id", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    connection.watched = [];
    indexer["subscribeToLogs"]();
    indexer["subscribeToSync"]();
    await indexer.tick();

    const pool = chain.poolAddress().toBase58();
    expect(connection.watched.map((address) => address.toBase58())).toEqual([pool, pool, pool]);
  });

  // Ticket 04: the live path costs no `getBlockTime` call, and must not
  // borrow the backfill path's real block time or fall back to wall time.
  it("timestamps a live event from the last observed chain time, not a block-time lookup", async () => {
    await put("pool", chain.poolAddress(), poolAccount());
    chain.recordChainTime(1_234_567n);
    indexer["subscribeToLogs"]();

    const pool = chain.poolAddress();
    connection.fireLogs(
      pool,
      "finalized",
      { err: null, signature: "sig-live", logs: batch("sig-live", 0n, [deposited]).logs },
      77,
    );
    await indexer["queue"];

    const event = await prisma.event.findFirstOrThrow({ where: { signature: "sig-live" } });
    expect(event.blockTime).toBe(1_234_567n);
    expect(event.slot).toBe(77n);
  });

  it("keeps the transaction's own block time on a backfilled event, even with a different chain time observed live", async () => {
    chain.recordChainTime(999_999n);
    expect(await indexer.ingestLogs(batch("sig-backfill", 40n, [deposited]))).toBe(1);
    const event = await prisma.event.findFirstOrThrow({ where: { signature: "sig-backfill" } });
    // batch()'s own fixed block time, not the 999_999n last observed live.
    expect(event.blockTime).toBe(1_700_000_000n);
  });
});

// `getProgramAccountsV2`'s index runs 13 to 24 seconds behind the chain
// (measured against devnet), so a sweep fired by a log hands back a snapshot
// from before the transaction that fired it. A confirmed log re-reads the
// accounts it names instead, and the sweep must not undo that.
describe("live account refresh", () => {
  const fire = async (logs: string[], slot: number): Promise<void> => {
    indexer["subscribeToSync"]();
    connection.fireLogs(
      chain.poolAddress(),
      "confirmed",
      { err: null, signature: `sig-${slot}`, logs: batch(`sig-${slot}`, BigInt(slot), logs).logs },
      slot,
    );
    await indexer["queue"];
  };

  it("re-reads the accounts one log names, in a single call, and writes them", async () => {
    const round = chain.roundAddress(4n);
    await put("pool", chain.poolAddress(), poolAccount({ openRoundId: bn(4), nextRoundId: bn(5) }));
    await put("epoch", chain.epochAddress(2n), epochAccount({ epochId: bn(2) }));
    await put("round", round, roundAccount({ roundId: bn(4), epochId: bn(2) }));
    await put("player", chain.playerAddress(OWNER), playerAccount(OWNER));
    connection.resetCalls();

    await fire([roundOpened, deposited], 300);

    expect(connection.callsTo("getMultipleAccountsInfo")).toBe(1);
    // The walk is the safety net now, not the live path: no page of it here.
    expect(connection.callsTo("_rpcRequest")).toBe(0);
    expect(await prisma.round.findUniqueOrThrow({ where: { id: 4n } })).toMatchObject({
      epochId: 2n,
      status: 0,
    });
    expect(await prisma.player.findUniqueOrThrow({ where: { owner: OWNER.toBase58() } }))
      .toMatchObject({ principal: 3_000_000n });
  });

  it("drops a Position the settle closed, without waiting for a full walk", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await put("position", chain.positionAddress(round, OWNER), positionAccount(OWNER, round));
    await indexer.syncAccounts();
    expect(await prisma.position.count()).toBe(1);

    // settle_position closed it: the account reads back as gone.
    connection.clearAccounts();
    await put("pool", chain.poolAddress(), poolAccount());
    await fire([positionSettled], 301);

    expect(await prisma.position.count()).toBe(0);
  });

  it("keeps a sweep's older snapshot from overwriting what the log path wrote", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    // The open Round is asked for by position rather than by event, so it
    // has to be one the mirror already knows about.
    await indexer.syncAccounts();

    // The live read sees the settled Round…
    await put("round", round, roundAccount({ status: 2, winningTile: 17 }));
    await fire([], 500);
    expect((await prisma.round.findUniqueOrThrow({ where: { id: 1n } })).winningTile).toBe(17);

    // …and a sweep whose snapshot predates it still reports it Open. The
    // fake answers every walk from slot 100, well behind the log's 500.
    await put("round", round, roundAccount({ status: 0, winningTile: 0 }));
    await indexer.syncAccounts();

    const stored = await prisma.round.findUniqueOrThrow({ where: { id: 1n } });
    expect(stored.status).toBe(2);
    expect(stored.winningTile).toBe(17);
  });

  it("lets a sweep that has caught up write again", async () => {
    const round = chain.roundAddress(1n);
    await put("pool", chain.poolAddress(), poolAccount());
    await put("round", round, roundAccount());
    await indexer.syncAccounts();

    await put("round", round, roundAccount({ status: 2, winningTile: 17 }));
    await fire([], 50); // behind the fake's own sweep slot of 100

    await put("round", round, roundAccount({ status: 0, winningTile: 0 }));
    await indexer.syncAccounts();

    expect((await prisma.round.findUniqueOrThrow({ where: { id: 1n } })).status).toBe(0);
    expect(indexer["freshWrites"].size).toBe(0);
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
    pendingWithdraw: 0n,
    pendingEpoch: 0n,
    principalAcc: "0",
    frozenPrincipalAcc: "0",
    yieldEpoch: 0n,
    boughtEpoch: 0n,
    boughtAmount: 0n,
    bonusEpoch: 0n,
    bonusGranted: 0n,
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
        { id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] },
        { id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, houseCut: 0n, tileTotals: [] },
      ],
    });
    expect(await indexer.getOpenRound()).toMatchObject({ id: 2n, status: 1 });
  });

  it("lists positions across every round that has reached a terminal status", async () => {
    await prisma.round.createMany({
      data: [
        { id: 1n, epochId: 5n, startsAt: 0n, endsAt: 60n, status: 2, pot: 0n, houseCut: 0n, tileTotals: [] }, // Settled
        { id: 2n, epochId: 5n, startsAt: 60n, endsAt: 120n, status: 1, pot: 5n, houseCut: 0n, tileTotals: [] }, // Requested: still live
        { id: 3n, epochId: 5n, startsAt: 120n, endsAt: 180n, status: 4, pot: 0n, houseCut: 0n, tileTotals: [] }, // Voided
      ],
    });
    await prisma.position.createMany({
      data: [
        { address: "pos-a", owner: ALICE, roundId: 1n, tiles: 1n, stakePerTile: 1n },
        { address: "pos-b", owner: BOB, roundId: 2n, tiles: 1n, stakePerTile: 1n },
        { address: "pos-c", owner: CAROL, roundId: 3n, tiles: 1n, stakePerTile: 1n },
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
