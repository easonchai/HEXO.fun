// Every event in spec §2.6 decoded from a `Program data:` line, plus the two
// the program emits that the spec's list omits.
//
// The bytes are laid out here by hand rather than by the Anchor coder that
// decodes them: encoding with the coder under test would pass whatever the
// coder happens to do. A field reordered in events.rs, a type widened, or a
// stale IDL snapshot all fail here.
import { BorshCoder, convertIdlToCamelCase, EventParser } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import { decodeEventLogs, jsonify, registrationWeight } from "./decode";

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);
// `Program` camelCases the IDL before building its coder, so the field names
// the indexer stores are camelCase even though the IDL file is snake_case.
// The coder here is built the same way for the same reason.
const parser = new EventParser(PROGRAM_ID, new BorshCoder(convertIdlToCamelCase(idl)));

const u8 = (value: number): Buffer => Buffer.from([value]);
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
    fields: [key(POOL), u64(7n), key(OWNER), key(MINT)],
    data: { pool: POOL, poolId: "7", authority: OWNER, acceptedMint: MINT },
  },
  {
    name: "ParamsSet",
    fields: [key(POOL), i64(86_400n), i64(60n), i64(5n), i64(120n), u64(1_000_000n)],
    data: {
      pool: POOL,
      epochSeconds: "86400",
      roundSeconds: "60",
      closeBuffer: "5",
      vrfTimeout: "120",
      minDeposit: "1000000",
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
    name: "Withdrawn",
    fields: [key(OWNER), u64(500_000n), u64(2_500_000n), u64(2_500_000n)],
    data: { owner: OWNER, amount: "500000", principal: "2500000", entries: "2500000" },
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
    fields: [u64(4n), u8(35), u64(9_000n), bool(false)],
    data: { roundId: "4", winningTile: 35, pot: "9000", forfeited: false },
  },
  {
    name: "RoundVoided",
    fields: [u64(4n), u64(9_000n)],
    data: { roundId: "4", carryPot: "9000" },
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
    fields: [u64(2n), key(OWNER), u64(10_000_000n), bool(true)],
    data: { epochId: "2", winner: OWNER, amount: "10000000", isHouse: true },
  },
  {
    name: "EpochRolledOver",
    fields: [u64(2n), u64(10_000_000n)],
    data: { epochId: "2", jackpotAmount: "10000000" },
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
