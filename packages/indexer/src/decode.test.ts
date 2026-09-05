import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  createEventDecoder,
  decodeLogs,
  loadIdl,
  toEventRows,
} from "./decode.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Prefer the fresh `anchor build` output; fall back to the committed web copy
// so the unit suite passes on a clean checkout with no prior program build.
const BUILD_IDL = resolve(HERE, "../../../target/idl/hex_vault.json");
const FALLBACK_IDL = resolve(
  HERE,
  "../../../apps/web/src/idl/hex_vault.json",
);
const IDL = loadIdl(existsSync(BUILD_IDL) ? BUILD_IDL : FALLBACK_IDL);
const decode = createEventDecoder(IDL);
/** The IDL lists event fields in `types`, keyed by the event name. */
const eventFields = (name: string): { name: string; type: unknown }[] => {
  const def = IDL.types?.find((candidate) => candidate.name === name);
  const fields =
    (def?.type as { fields?: { name: string; type: unknown }[] }).fields ?? [];
  return fields;
};
const POOL = "6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB";
const OWNER = createHash("sha256").update("owner").digest();
const OWNER_ADDR = new PublicKey(OWNER).toBase58();

const u64le = (value: bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

const discriminator = (name: string): Buffer =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

/** Hand-rolled borsh encoder — the fixture side of the round trip. */
const programData = (name: string, body: Buffer): string =>
  `Program data: ${Buffer.concat([discriminator(name), body]).toString("base64")}`;

describe("event decode", () => {
  it("decodes a DepositRecorded log line", () => {
    const body = Buffer.concat([OWNER, OWNER, u64le(3n), u64le(1_500_000n)]);
    const event = decode(programData("DepositRecorded", body));
    expect(event).not.toBeNull();
    expect(event!.name).toBe("DepositRecorded");
    expect(event!.pool).toBe(OWNER_ADDR);
    expect(event!.payload.epoch_id).toBe("3");
    expect(event!.payload.amount).toBe("1500000");
  });

  it("decodes a PrizeSnapshotCommitted log line with a 32-byte root", () => {
    const root = createHash("sha256").update("root").digest();
    const body = Buffer.concat([
      OWNER,
      u64le(7n),
      u64le(250n),
      u64le(1_000n),
      root,
    ]);
    const event = decode(programData("PrizeSnapshotCommitted", body));
    expect(event!.name).toBe("PrizeSnapshotCommitted");
    expect(event!.payload.epoch_id).toBe("7");
    expect(event!.payload.prize_amount).toBe("250");
    expect(event!.payload.total_entry_weight).toBe("1000");
    expect(event!.payload.root).toEqual([...root]);
  });

  it("rejects non-Program-data lines and unknown discriminators", () => {
    expect(decode("Program log: Instruction: Deposit")).toBeNull();
    expect(decode("Program data: not-base64!")).toBeNull();
    const garbage = Buffer.alloc(40, 1).toString("base64");
    expect(decode(`Program data: ${garbage}`)).toBeNull();
  });

  it("decodes every one of the 22 IDL events to a payload that carries a pool", () => {
    expect(IDL.events).toHaveLength(22);
    for (const event of IDL.events ?? []) {
      const body = Buffer.concat(
        eventFields(event.name).map((field) => {
          const type = field.type;
          if (type === "pubkey") return OWNER;
          if (type === "u64" || type === "i64") return u64le(5n);
          if (type === "bool") return Buffer.from([1]);
          if (type === "u8") return Buffer.from([2]);
          if (type && typeof type === "object" && "array" in (type as object)) {
            return Buffer.alloc(32, 9);
          }
          throw new Error(
            `fixture missing for ${event.name}.${field.name}: ${JSON.stringify(type)}`,
          );
        }),
      );
      const decoded = decode(programData(event.name, body));
      expect(decoded, event.name).not.toBeNull();
      expect(decoded!.pool, event.name).toBe(OWNER_ADDR);
    }
  });

  it("decodes only data emitted by the configured program invocation", () => {
    const other = OWNER_ADDR;
    const line = programData(
      "DepositRecorded",
      Buffer.concat([OWNER, OWNER, u64le(1n), u64le(10n)]),
    );
    expect(
      decodeLogs(
        [
          `Program ${other} invoke [1]`,
          line,
          `Program ${other} success`,
          `Program ${POOL} invoke [1]`,
          `Program ${other} invoke [2]`,
          line,
          `Program ${other} success`,
          `Program data: not-base64!`,
          `Program ${POOL} success`,
        ],
        decode,
        POOL,
      ),
    ).toEqual([]);

    expect(
      decodeLogs(
        [`Program ${POOL} invoke [1]`, line, `Program ${POOL} success`],
        decode,
        POOL,
      ),
    ).toHaveLength(1);
  });

  it("collects rows per transaction and leaves the cursor null when empty", () => {
    const line = programData(
      "DepositRecorded",
      Buffer.concat([OWNER, OWNER, u64le(1n), u64le(10n)]),
    );
    // Real transactions always carry the invoking program's frame, and the
    // provenance filter needs it to attribute `Program data:` to our program.
    const ours = [
      `Program ${POOL} invoke [1]`,
      line,
      `Program ${POOL} success`,
    ];
    const batch = toEventRows(
      [
        { slot: 5n, signature: "SIGB", logs: ours, blockTime: 1 },
        { slot: 5n, signature: "SIGA", logs: ours, blockTime: 1 },
        // SIG0 emits nothing, so it produces no row and no cursor entry.
        {
          slot: 4n,
          signature: "SIG0",
          logs: ["Program log: nothing"],
          blockTime: 1,
        },
      ],
      decode,
      POOL,
    );
    // Ordering by (slot, signature, eventIndex) is the store's job, not the
    // decoder's: it mirrors how log callbacks actually arrive.
    expect(batch.events.map((event) => event.signature)).toEqual([
      "SIGB",
      "SIGA",
    ]);
    expect(batch.events.every((event) => event.pool === OWNER_ADDR)).toBe(true);
    expect(batch.cursor?.slot).toBe(5n);
    expect(decodeLogs([], decode)).toEqual([]);

    const empty = toEventRows(
      [{ slot: 1n, signature: "X", logs: ["Program log: hi"] }],
      decode,
      POOL,
    );
    expect(empty.events).toHaveLength(0);
    expect(empty.cursor).toBeNull();
  });
});
