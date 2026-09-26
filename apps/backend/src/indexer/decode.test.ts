// Every event in spec §2.6 decoded from a `Program data:` line, plus the two
// the program emits that the spec's list omits.
//
// The bytes are laid out here by hand rather than by the Anchor coder that
// decodes them: encoding with the coder under test would pass whatever the
// coder happens to do. A field reordered in events.rs, a type widened, or a
// stale IDL snapshot all fail here.
import { BN, BorshCoder, convertIdlToCamelCase, EventParser } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import {
  decodeEventLogs,
  jsonify,
  playerRow,
  poolRow,
  registrationWeight,
  ROUND_STATUS,
  roundRow,
  type DecodedPlayer,
  type DecodedPool,
  type DecodedRound,
} from "./decode";

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
// `Program` camelCases the IDL before building its coder, so the field names
// the indexer stores are camelCase even though the IDL file is snake_case.
// The coder here is built the same way for the same reason.
const parser = new EventParser(PROGRAM_ID, new BorshCoder(convertIdlToCamelCase(idl)));

const u8 = (value: number): Buffer => Buffer.from([value]);
const u16 = (value: number): Buffer => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
};
const bool = (value: boolean): Buffer => Buffer.from([value ? 1 : 0]);

const u64 = (value: bigint): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
};

const i64 = (value: bigint): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return buf;
};

const u128 = (value: bigint): Buffer =>
  Buffer.concat([u64(value & 0xffffffffffffffffn), u64(value >> 64n)]);

const key = (base58: string): Buffer => new PublicKey(base58).toBuffer();

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POOL = "So11111111111111111111111111111111111111112";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** One transaction's logs, shaped the way the RPC delivers them. */
function logs(discriminator: number[], fields: Buffer[]): string[] {
  const payload = Buffer.concat([Buffer.from(discriminator), ...fields]);
  return [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    "Program log: Instruction: Whatever",
    `Program data: ${payload.toString("base64")}`,
    `Program ${PROGRAM_ID.toBase58()} consumed 12345 of 200000 compute units`,
    `Program ${PROGRAM_ID.toBase58()} success`,
  ];
}

function discriminatorOf(name: string): number[] {
  const event = (idl.events ?? []).find((candidate) => candidate.name === name);
  if (!event) throw new Error(`event ${name} is not in the IDL`);
  return event.discriminator;
}

interface Case {
  name: string;
  fields: Buffer[];
  data: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "PoolCreated",
    fields: [key(POOL), u64(7n), key(OWNER), key(MINT), key(MINT)],
    data: { pool: POOL, poolId: "7", admin: OWNER, operator: MINT, acceptedMint: MINT },
  },
  {
    name: "OperatorChanged",
    fields: [key(POOL), key(OWNER), key(MINT)],
    data: { pool: POOL, previous: OWNER, operator: MINT },
  },
  {
    name: "AdminProposed",
    fields: [key(POOL), key(OWNER)],
    data: { pool: POOL, pendingAdmin: OWNER },
  },
  {
    name: "AdminChanged",
    fields: [key(POOL), key(OWNER), key(MINT)],
    data: { pool: POOL, previous: OWNER, admin: MINT },
  },
  {
    name: "ParamsSet",
    fields: [
      key(POOL),
      i64(86_400n),
      i64(1_789_315_200n),
      i64(60n),
      i64(5n),
      i64(120n),
      u64(1_000_000n),
      u16(600),
      u64(2_000_000n),
      i64(600n),
      i64(86_400n),
      u16(488),
      u16(10),
      u16(500),
    ],
    data: {
      pool: POOL,
      epochSeconds: "86400",
      epochAnchor: "1789315200",
      roundSeconds: "60",
      closeBuffer: "5",
      vrfTimeout: "120",
      minDeposit: "1000000",
      houseCutBps: 600,
      minJackpot: "2000000",
      registrationWindow: "600",
      payoutTimeout: "86400",
      baseRateBps: 488,
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
    },
  },
  {
    name: "Paused",
    fields: [key(POOL), bool(true)],
    data: { pool: POOL, paused: true },
  },
  {
    name: "Deposited",
    fields: [key(OWNER), u64(1_000_000n), u64(3_000_000n), u64(3_000_000n)],
    data: { owner: OWNER, amount: "1000000", principal: "3000000", entries: "3000000" },
  },
  {
    name: "WithdrawRequested",
    fields: [key(OWNER), u64(500_000n), u64(750_000n), u64(4n)],
    data: { owner: OWNER, amount: "500000", pending: "750000", pendingEpoch: "4" },
  },
  {
    name: "Withdrawn",
    fields: [key(OWNER), u64(500_000n), u64(2_500_000n), u64(2_500_000n)],
    data: { owner: OWNER, amount: "500000", principal: "2500000", entries: "2500000" },
  },
  {
    name: "PrincipalDeployed",
    fields: [key(POOL), u64(40_000_000n), u64(2_000_000n)],
    data: { pool: POOL, amount: "40000000", vaultRemaining: "2000000" },
  },
  {
    name: "RoundOpened",
    fields: [u64(4n), u64(2n), i64(1_700_000_000n), i64(1_700_000_060n), u64(250n)],
    data: {
      roundId: "4",
      epochId: "2",
      startsAt: "1700000000",
      endsAt: "1700000060",
      carryIn: "250",
    },
  },
  {
    name: "PositionBought",
    fields: [u64(4n), key(OWNER), u64(0b101n), u64(1_000n), u64(2_000n)],
    data: { roundId: "4", owner: OWNER, tiles: "5", stakePerTile: "1000", total: "2000" },
  },
  {
    name: "RoundSettled",
    fields: [u64(4n), u8(35), u64(9_000n), bool(false), u64(540n)],
    data: {
      roundId: "4",
      winningTile: 35,
      pot: "9000",
      forfeited: false,
      houseCut: "540",
    },
  },
  {
    name: "RoundVoided",
    fields: [u64(4n), u64(9_000n)],
    data: { roundId: "4", carryPot: "9000" },
  },
  {
    name: "RoundClosed",
    fields: [key(MINT), u64(4n)],
    data: { round: MINT, roundId: "4" },
  },
  {
    name: "PositionSettled",
    fields: [u64(4n), key(OWNER), u64(4_500n)],
    data: { roundId: "4", owner: OWNER, reward: "4500" },
  },
  {
    name: "EpochBegan",
    fields: [u64(3n), i64(1_700_000_000n), i64(1_700_086_400n)],
    data: { epochId: "3", startsAt: "1700000000", endsAt: "1700086400" },
  },
  {
    name: "Registered",
    // A u128 past 2^64 catches a field decoded as the wrong width.
    fields: [u64(2n), key(OWNER), u128(1n << 70n), u128(0n), u128(1n << 70n)],
    data: {
      epochId: "2",
      owner: OWNER,
      weight: "1180591620717411303424",
      regStart: "0",
      regEnd: "1180591620717411303424",
    },
  },
  {
    name: "JackpotFunded",
    fields: [key(OWNER), u64(10_000_000n)],
    data: { source: OWNER, amount: "10000000" },
  },
  {
    name: "EpochDrawn",
    fields: [u64(2n), u128(42n), u128(1n << 70n)],
    data: { epochId: "2", target: "42", registeredWeight: "1180591620717411303424" },
  },
  {
    name: "JackpotPaid",
    fields: [u64(2n), key(OWNER), u64(10_000_000n), bool(true), bool(false)],
    data: {
      epochId: "2",
      winner: OWNER,
      amount: "10000000",
      isHouse: true,
      compounded: false,
    },
  },
  {
    name: "EpochRolledOver",
    fields: [u64(2n), u64(10_000_000n)],
    data: { epochId: "2", jackpotAmount: "10000000" },
  },
  {
    name: "YieldFunded",
    fields: [u64(5_000_000n), u64(12_000_000n)],
    data: { amount: "5000000", budget: "12000000" },
  },
  {
    name: "YieldCredited",
    fields: [u64(2n), key(OWNER), u64(1_200n), u64(300n)],
    data: { epochId: "2", owner: OWNER, amount: "1200", shortfall: "300" },
  },
  {
    name: "TicketsBought",
    fields: [key(OWNER), u64(2n), u64(500_000n), u64(5_000_000n)],
    data: { owner: OWNER, epochId: "2", usdc: "500000", tickets: "5000000" },
  },
  {
    name: "TicketsGranted",
    fields: [key(OWNER), u64(2n), u64(750_000n), bool(false)],
    data: { owner: OWNER, epochId: "2", amount: "750000", byAdmin: false },
  },
  {
    name: "PoolShutdown",
    fields: [key(POOL), i64(1_700_000_000n)],
    data: { pool: POOL, at: "1700000000" },
  },
  {
    name: "EmergencyWithdrawn",
    fields: [key(OWNER), u64(3_000_000n), u64(500_000n), u64(3_500_000n)],
    data: { owner: OWNER, principal: "3000000", pending: "500000", total: "3500000" },
  },
  {
    name: "HouseSwept",
    fields: [u64(10_000_000n), u64(2_000_000n)],
    data: { jackpot: "10000000", yieldBudget: "2000000" },
  },
];

describe("decodeEventLogs", () => {
  it.each(CASES)("decodes $name", ({ name, fields, data }) => {
    const decoded = decodeEventLogs(parser, logs(discriminatorOf(name), fields));
    expect(decoded).toEqual([{ name, data }]);
  });

  it("covers every event in the IDL", () => {
    expect(CASES.map((event) => event.name).sort()).toEqual(
      (idl.events ?? []).map((event) => event.name).sort(),
    );
  });

  it("indexes several events from one transaction in emission order", () => {
    const first = logs(discriminatorOf("Deposited"), [
      key(OWNER),
      u64(1n),
      u64(1n),
      u64(1n),
    ]);
    const second = logs(discriminatorOf("EpochBegan"), [u64(1n), i64(0n), i64(60n)]);
    // Splice the second event's data line into the first transaction's logs.
    const combined = [...first.slice(0, 3), second[2] as string, ...first.slice(3)];
    expect(decodeEventLogs(parser, combined).map((event) => event.name)).toEqual([
      "Deposited",
      "EpochBegan",
    ]);
  });

  it("ignores a log line that is not an event", () => {
    expect(
      decodeEventLogs(parser, [
        `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
        "Program log: nothing to see",
        `Program ${PROGRAM_ID.toBase58()} success`,
      ]),
    ).toEqual([]);
  });

  it("names the batch it could not parse", () => {
    expect(() => decodeEventLogs(parser, ["Program log: orphaned line"])).toThrow(
      /cannot parse program logs: Program log: orphaned line/,
    );
  });
});

describe("jsonify", () => {
  it("keeps a u64 exact as a decimal string", () => {
    const decoded = decodeEventLogs(
      parser,
      logs(discriminatorOf("Deposited"), [
        key(OWNER),
        u64(18_446_744_073_709_551_615n),
        u64(0n),
        u64(0n),
      ]),
    );
    expect(decoded[0]?.data).toMatchObject({ amount: "18446744073709551615" });
  });

  it("passes plain values through", () => {
    expect(jsonify({ a: [1, "b", true], c: null })).toEqual({ a: [1, "b", true], c: null });
  });
});

describe("poolRow", () => {
  // The epoch grid timestamps take the same BN -> BigInt path as
  // `epochSeconds`, so a name that drifts from the IDL drops them silently.
  // The API's interceptor is what turns these columns into decimal strings.
  it("carries the epoch grid timestamps", () => {
    const pool: DecodedPool = {
      poolId: new BN(7),
      admin: new PublicKey(OWNER),
      operator: new PublicKey(MINT),
      pendingAdmin: PublicKey.default,
      acceptedMint: new PublicKey(MINT),
      pendingWithdrawals: new BN(250_000),
      minJackpot: new BN(1_000_000),
      epochSeconds: new BN(86_400),
      epochAnchor: new BN(1_789_315_200),
      roundSeconds: new BN(60),
      closeBuffer: new BN(12),
      minDeposit: new BN(1_000_000),
      houseCutBps: 600,
      paused: false,
      currentEpochId: new BN(3),
      currentEpochEndsAt: new BN(1_789_488_000),
      previousEpochEndsAt: new BN(1_789_401_600),
      totalPrincipal: new BN(3_000_000),
      carryPot: new BN(0),
      baseRateBps: 488,
      yieldBudget: new BN(9_000_000),
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
      bonusEpoch: new BN(3),
      bonusGranted: new BN(40_000),
      version: 1,
      shutdown: false,
    };
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      epochSeconds: 86_400n,
      epochAnchor: 1_789_315_200n,
      currentEpochEndsAt: 1_789_488_000n,
      previousEpochEndsAt: 1_789_401_600n,
      houseCutBps: 600,
      // The browser reads these two off the API now, so they have to survive
      // the decode rather than being dropped (ticket 07).
      closeBuffer: 12n,
      minDeposit: 1_000_000n,
    });
  });

  // Ticket 05: base yield, bought tickets and granted tickets.
  it("carries the base yield and ticket-economy fields", () => {
    const pool: DecodedPool = {
      poolId: new BN(7),
      admin: new PublicKey(OWNER),
      operator: new PublicKey(MINT),
      pendingAdmin: PublicKey.default,
      acceptedMint: new PublicKey(MINT),
      pendingWithdrawals: new BN(0),
      minJackpot: new BN(0),
      epochSeconds: new BN(86_400),
      epochAnchor: new BN(0),
      roundSeconds: new BN(90),
      closeBuffer: new BN(12),
      minDeposit: new BN(0),
      houseCutBps: 0,
      paused: false,
      currentEpochId: new BN(3),
      currentEpochEndsAt: new BN(0),
      previousEpochEndsAt: new BN(0),
      totalPrincipal: new BN(0),
      carryPot: new BN(0),
      baseRateBps: 488,
      yieldBudget: new BN(9_000_000),
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
      bonusEpoch: new BN(3),
      bonusGranted: new BN(40_000),
      version: 1,
      shutdown: false,
    };
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      baseRateBps: 488,
      yieldBudget: 9_000_000n,
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
      bonusEpoch: 3n,
      bonusGranted: 40_000n,
    });
  });

  // Ticket 03: the old single `authority` column is gone, and /status reads
  // what depositors are owed off this row.
  it("splits the roles and carries the withdrawal fields", () => {
    const pool: DecodedPool = {
      poolId: new BN(7),
      admin: new PublicKey(OWNER),
      operator: new PublicKey(MINT),
      pendingAdmin: new PublicKey(POOL),
      acceptedMint: new PublicKey(MINT),
      pendingWithdrawals: new BN(250_000),
      minJackpot: new BN(1_000_000),
      epochSeconds: new BN(86_400),
      epochAnchor: new BN(1_789_315_200),
      roundSeconds: new BN(90),
      closeBuffer: new BN(12),
      minDeposit: new BN(1_000_000),
      houseCutBps: 600,
      paused: false,
      currentEpochId: new BN(3),
      currentEpochEndsAt: new BN(1_789_488_000),
      previousEpochEndsAt: new BN(1_789_401_600),
      totalPrincipal: new BN(3_000_000),
      carryPot: new BN(0),
      baseRateBps: 488,
      yieldBudget: new BN(0),
      ticketsPerUsdc: 10,
      bonusCapBps: 500,
      bonusEpoch: new BN(0),
      bonusGranted: new BN(0),
      version: 1,
      shutdown: false,
    };
    expect(poolRow(new PublicKey(POOL), pool, 9n)).toMatchObject({
      admin: OWNER,
      operator: MINT,
      pendingAdmin: POOL,
      pendingWithdrawals: 250_000n,
      minJackpot: 1_000_000n,
    });
  });

  it("reports no pending admin when the handover slot is the default key", () => {
    const pool: DecodedPool = {
      poolId: new BN(7),
      admin: new PublicKey(OWNER),
      operator: new PublicKey(MINT),
      pendingAdmin: PublicKey.default,
      acceptedMint: new PublicKey(MINT),
      pendingWithdrawals: new BN(0),
      minJackpot: new BN(0),
      epochSeconds: new BN(86_400),
      epochAnchor: new BN(0),
      roundSeconds: new BN(90),
      closeBuffer: new BN(12),
      minDeposit: new BN(0),
      houseCutBps: 0,
      paused: false,
      currentEpochId: new BN(0),
      currentEpochEndsAt: new BN(0),
      previousEpochEndsAt: new BN(0),
      totalPrincipal: new BN(0),
      carryPot: new BN(0),
      baseRateBps: 0,
      yieldBudget: new BN(0),
      ticketsPerUsdc: 10,
      bonusCapBps: 0,
      bonusEpoch: new BN(0),
      bonusGranted: new BN(0),
      version: 1,
      shutdown: false,
    };
    expect(poolRow(new PublicKey(POOL), pool, 9n).pendingAdmin).toBeNull();
  });
});

describe("playerRow", () => {
  // Ticket 03: `request_withdraw` parks the amount on the Player and the
  // vault screen reads it back off /players/:owner, so a field dropped here
  // is a depositor who cannot see their own pending money.
  it("carries the pending withdrawal, the epoch it pays in and when it was requested", () => {
    const player: DecodedPlayer = {
      owner: new PublicKey(OWNER),
      principal: new BN(3_000_000),
      entries: new BN(3_000_000),
      weightAcc: new BN(0),
      lastUpdate: new BN(1_700_000_000),
      epochId: new BN(4),
      frozenWeight: new BN(0),
      frozenEpoch: new BN(0),
      regEpoch: new BN(0),
      regStart: new BN(0),
      regEnd: new BN(0),
      isHouse: false,
      pendingWithdraw: new BN(750_000),
      pendingEpoch: new BN(4),
      requestedAt: new BN(1_700_000_000),
      principalAcc: new BN(0),
      frozenPrincipalAcc: new BN(0),
      yieldEpoch: new BN(0),
      boughtEpoch: new BN(0),
      boughtAmount: new BN(0),
      bonusEpoch: new BN(0),
      bonusGranted: new BN(0),
    };
    expect(playerRow(player)).toMatchObject({
      pendingWithdraw: 750_000n,
      pendingEpoch: 4n,
      // Pre-mainnet review: the second way a request matures (custody.rs's
      // `now > requested_at + epoch_seconds`), so the web can offer the
      // dead-operator payout hatch.
      requestedAt: 1_700_000_000n,
    });
  });

  // Ticket 05: base yield's principal-seconds accumulator and the bought/
  // granted ticket counters.
  it("carries the base yield and ticket-economy fields", () => {
    const player: DecodedPlayer = {
      owner: new PublicKey(OWNER),
      principal: new BN(3_000_000),
      entries: new BN(3_000_000),
      weightAcc: new BN(0),
      lastUpdate: new BN(1_700_000_000),
      epochId: new BN(4),
      frozenWeight: new BN(0),
      frozenEpoch: new BN(0),
      regEpoch: new BN(0),
      regStart: new BN(0),
      regEnd: new BN(0),
      isHouse: false,
      pendingWithdraw: new BN(0),
      pendingEpoch: new BN(0),
      requestedAt: new BN(0),
      // A u128 past 2^64, like `Registered`'s weight fixture: proves this
      // takes the same BN -> Decimal(40,0) string path as weightAcc, not a
      // truncating BN -> Number one.
      principalAcc: new BN("18446744073709551617"),
      frozenPrincipalAcc: new BN(500),
      yieldEpoch: new BN(3),
      boughtEpoch: new BN(4),
      boughtAmount: new BN(200_000),
      bonusEpoch: new BN(4),
      bonusGranted: new BN(50_000),
    };
    expect(playerRow(player)).toMatchObject({
      principalAcc: "18446744073709551617",
      frozenPrincipalAcc: "500",
      yieldEpoch: 3n,
      boughtEpoch: 4n,
      boughtAmount: 200_000n,
      bonusEpoch: 4n,
      bonusGranted: 50_000n,
    });
  });
});

describe("roundRow", () => {
  it("carries the House cut", () => {
    const round: DecodedRound = {
      roundId: new BN(4),
      epochId: new BN(2),
      startsAt: new BN(1_700_000_000),
      endsAt: new BN(1_700_000_060),
      status: ROUND_STATUS.SETTLED,
      tileTotals: Array(36).fill(new BN(0)),
      pot: new BN(9_000),
      houseCut: new BN(540),
      winningTile: 35,
    };
    expect(roundRow(round)).toMatchObject({ pot: 9_000n, houseCut: 540n });
  });
});

// spec §2.3, the `register` weight rule. The operator asks for players whose
// weight is non-zero, because the program returns Ok without registering a
// zero and the transaction would be wasted.
describe("registrationWeight", () => {
  const epoch = { id: 5n, startsAt: 1_000n, endsAt: 2_000n };
  const base = {
    epochId: 5n,
    weightAcc: dec(0n),
    entries: 0n,
    lastUpdate: 1_000n,
    principal: 0n,
    frozenWeight: dec(0n),
    frozenEpoch: 0n,
  };

  it("accrues to the epoch end when the player was last touched inside it", () => {
    const player = { ...base, weightAcc: dec(500n), entries: 3n, lastUpdate: 1_400n };
    expect(registrationWeight(player, epoch)).toBe(500n + 3n * 600n);
  });

  it("uses the frozen weight when the player has moved on to a later epoch", () => {
    const player = { ...base, epochId: 6n, frozenWeight: dec(777n), frozenEpoch: 5n };
    expect(registrationWeight(player, epoch)).toBe(777n);
  });

  it("is zero when a later-epoch player froze a different epoch", () => {
    const player = { ...base, epochId: 7n, frozenWeight: dec(777n), frozenEpoch: 6n };
    expect(registrationWeight(player, epoch)).toBe(0n);
  });

  it("credits a full epoch of principal to a player idle since before it", () => {
    const player = { ...base, epochId: 3n, principal: 2n };
    expect(registrationWeight(player, epoch)).toBe(2n * 1_000n);
  });

  it("never returns a negative weight from a drifted row", () => {
    const player = { ...base, entries: 5n, lastUpdate: 9_999n };
    expect(registrationWeight(player, epoch)).toBe(0n);
  });
});

/** Stands in for the Decimal(40, 0) columns Prisma returns. */
function dec(value: bigint): { toFixed(places: number): string } {
  return { toFixed: () => value.toString() };
}
