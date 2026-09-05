// Step selection is the whole operator: given a state, exactly one thing
// should happen. The instructions built here are the real ones, decoded back
// out of the recorded transaction, so a wrong account list still shows up.
import {
  AnchorProvider,
  BorshInstructionCoder,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { loadIdl } from "../chain/idl";
import { poolAddress } from "../chain/pda";
import {
  EPOCH_STATUS,
  ROUND_STATUS,
  clockUnixTimestamp,
  type EpochState,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";
import { runTick, yieldAmount, type TickContext } from "./tick";
import { isFulfilled, keccak256, randomnessAddress, vrfSeed } from "./vrf";

const AUTHORITY = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);

// No RPC is reached: every account is passed explicitly, so Anchor never has
// to resolve one.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);
const coder = new BorshInstructionCoder(idl);
const instructions = new OperatorInstructions(program, PROGRAM_ID, AUTHORITY, true);

/** Readable name for one recorded instruction, whoever owns it. */
function label(ix: TransactionInstruction): string {
  if (ix.programId.equals(PROGRAM_ID)) {
    return coder.decode(ix.data)?.name ?? "unknown";
  }
  if (ix.programId.equals(TOKEN_PROGRAM_ID)) return `token:${ix.data[0]}`;
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return `ata:${ix.data[0]}`;
  return ix.programId.toBase58();
}

const MINT_TO = `token:${TokenInstruction.MintTo}`;
const CREATE_ATA_IDEMPOTENT = "ata:1";

const NOW = 1_800_000_000n;

const pool = (over: Partial<PoolState> = {}): PoolState => ({
  address: POOL,
  authority: AUTHORITY,
  acceptedMint: MINT,
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: 86_400n,
  roundSeconds: 60n,
  vrfTimeout: 120n,
  paused: false,
  currentEpochId: 2n,
  nextRoundId: 4n,
  openRoundId: 3n,
  totalPrincipal: 1_000_000_000n,
  ...over,
});

const epoch = (over: Partial<EpochState> = {}): EpochState => ({
  epochId: 2n,
  startsAt: NOW - 100n,
  endsAt: NOW + 86_300n,
  status: EPOCH_STATUS.OPEN,
  registeredCount: 0,
  jackpotAmount: 0n,
  vrfSeed: new Uint8Array(32).fill(3),
  requestedAt: 0n,
  target: 0n,
  ...over,
});

const round = (over: Partial<RoundState> = {}): RoundState => ({
  roundId: 3n,
  endsAt: NOW + 30n,
  status: ROUND_STATUS.OPEN,
  vrfSeed: new Uint8Array(32).fill(5),
  requestedAt: 0n,
  ...over,
});

interface Recorder {
  ctx: TickContext;
  sent: TransactionInstruction[][];
}

function context(over: Partial<TickContext> = {}): Recorder {
  const sent: TransactionInstruction[][] = [];
  const ctx: TickContext = {
    now: NOW,
    pool: pool(),
    // A healthy mid-round state: epoch running, previous one already paid,
    // round open and not yet over.
    currentEpoch: epoch(),
    previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.PAID }),
    openRound: round(),
    aprBps: 500n,
    jackpotFloor: 10_000_000n,
    ix: instructions,
    fulfilled: async () => false,
    authorityBalance: async () => 0n,
    playersToRegister: async () => [],
    unsettledPositions: async () => [],
    winner: async () => null,
    send: async (ixs) => {
      sent.push(ixs);
      return "signature";
    },
    ...over,
  };
  return { ctx, sent };
}

/** Runs one tick and returns the labels of the single transaction it sent. */
async function tickLabels(over: Partial<TickContext> = {}): Promise<{
  action: string | null;
  labels: string[];
  transactions: number;
}> {
  const { ctx, sent } = context(over);
  const outcome = await runTick(ctx);
  return {
    action: outcome.action,
    labels: (sent[0] ?? []).map(label),
    transactions: sent.length,
  };
}

describe("runTick", () => {
  it("sends nothing on a healthy mid-round state", async () => {
    const result = await tickLabels();
    expect(result.transactions).toBe(0);
    expect(result.action).toBeNull();
  });

  it("1. begins the first epoch when the pool has none", async () => {
    const result = await tickLabels({
      pool: pool({ currentEpochId: 0n, nextRoundId: 1n, openRoundId: 0n }),
      currentEpoch: null,
      previousEpoch: null,
      openRound: null,
    });
    expect(result.labels).toEqual(["begin_epoch"]);
    expect(result.action).toBe("begin_epoch");
  });

  it("1. begins the next epoch once the current one has ended", async () => {
    const result = await tickLabels({ currentEpoch: epoch({ endsAt: NOW }) });
    expect(result.labels).toEqual(["begin_epoch"]);
  });

  it("2. registers up to eight players per transaction", async () => {
    const owners = Array.from({ length: 10 }, () => Keypair.generate().publicKey.toBase58());
    const { ctx, sent } = context({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.REGISTERING,
        registeredCount: 2,
      }),
      playersToRegister: async () => owners,
    });
    const outcome = await runTick(ctx);

    expect(sent).toHaveLength(1);
    expect((sent[0] ?? []).map(label)).toEqual(Array(8).fill("register"));
    expect(outcome.progress).toEqual({ count: 2, total: 12 });
  });

  it("2. funds the jackpot and closes registration once nobody is left", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.REGISTERING }),
      authorityBalance: async () => 999_999_999n,
    });
    expect(result.labels).toEqual(["fund_jackpot", "close_registration"]);
    expect(result.action).toBe("close_registration");
  });

  it("2. mints to itself first when the authority is short", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.REGISTERING }),
      authorityBalance: async () => 0n,
    });
    expect(result.labels).toEqual([MINT_TO, "fund_jackpot", "close_registration"]);
  });

  it("3. draws once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWING, requestedAt: NOW }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["draw"]);
  });

  it("3. rolls the epoch over when the randomness never arrives", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 121n,
      }),
    });
    expect(result.labels).toEqual(["rollover_epoch"]);
    expect(result.action).toBe("rollover_epoch");
  });

  it("3. waits while the request is still inside the timeout", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({
        epochId: 1n,
        status: EPOCH_STATUS.DRAWING,
        requestedAt: NOW - 10n,
      }),
    });
    expect(result.transactions).toBe(0);
  });

  it("4. pays the winner, creating their token account in the same transaction", async () => {
    const winner = Keypair.generate().publicKey.toBase58();
    const result = await tickLabels({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n }),
      winner: async (epochId, target) =>
        epochId === 1n && target === 42n ? winner : null,
    });
    expect(result.labels).toEqual([CREATE_ATA_IDEMPOTENT, "payout"]);
  });

  it("4. waits when no registered interval covers the target yet", async () => {
    const result = await tickLabels({
      previousEpoch: epoch({ epochId: 1n, status: EPOCH_STATUS.DRAWN, target: 42n }),
      openRound: round({ endsAt: NOW + 1n }),
    });
    expect(result.transactions).toBe(0);
  });

  it("5. requests randomness for a round that has ended", async () => {
    const result = await tickLabels({ openRound: round({ endsAt: NOW }) });
    expect(result.labels).toEqual(["request_round_randomness"]);
  });

  it("6. settles a requested round once the randomness is fulfilled", async () => {
    const result = await tickLabels({
      openRound: round({ status: ROUND_STATUS.REQUESTED, requestedAt: NOW - 5n }),
      fulfilled: async () => true,
    });
    expect(result.labels).toEqual(["settle_round"]);
  });

  it("6. voids a requested round after the timeout", async () => {
    const result = await tickLabels({
      openRound: round({ status: ROUND_STATUS.REQUESTED, requestedAt: NOW - 121n }),
    });
    expect(result.labels).toEqual(["void_round"]);
  });

  it("7. settles up to eight leftover positions per transaction", async () => {
    const positions = Array.from({ length: 9 }, () => ({
      address: Keypair.generate().publicKey.toBase58(),
      owner: Keypair.generate().publicKey.toBase58(),
    }));
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      openRound: null,
      unsettledPositions: async (roundId) => (roundId === 3n ? positions : []),
    });
    expect(result.labels).toEqual(Array(8).fill("settle_position"));
    expect(result.action).toBe("settle_position");
  });

  it("8. opens the next round when the last one is fully settled", async () => {
    const result = await tickLabels({ pool: pool({ openRoundId: 0n }), openRound: null });
    expect(result.labels).toEqual(["create_round"]);
  });

  it("8. does not open a round that would outlast the epoch", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n }),
      currentEpoch: epoch({ endsAt: NOW + 59n }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
  });

  it("8. does not open a round while the pool is paused", async () => {
    const result = await tickLabels({
      pool: pool({ openRoundId: 0n, paused: true }),
      openRound: null,
    });
    expect(result.transactions).toBe(0);
  });
});

describe("yieldAmount", () => {
  it("accrues APR over the epoch length and floors the result", () => {
    // 1,000 hexUSDC at 5% for one day.
    const principal = 1_000_000_000n;
    expect(yieldAmount(principal, 500n, 86_400n, 0n)).toBe(136_986n);
    expect(yieldAmount(principal, 500n, 86_400n, 10_000_000n)).toBe(10_000_000n);
  });

  it("pays the accrued amount once it clears the floor", () => {
    // 1,000,000 hexUSDC at 5% for one day is 136.98 hexUSDC.
    expect(yieldAmount(1_000_000_000_000n, 500n, 86_400n, 10_000_000n)).toBe(136_986_301n);
  });
});

describe("randomness", () => {
  it("hashes seeds the way solana_keccak_hasher does", () => {
    expect(Buffer.from(keccak256(new Uint8Array(0))).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(Buffer.from(keccak256(Buffer.from("abc"))).toString("hex")).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("separates seeds by domain, pool and id", () => {
    const other = poolAddress(PROGRAM_ID, 2n);
    const base = vrfSeed("epoch", POOL, 7n);
    expect(Buffer.from(vrfSeed("epoch", POOL, 7n))).toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("round", POOL, 7n))).not.toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("epoch", other, 7n))).not.toEqual(Buffer.from(base));
    expect(Buffer.from(vrfSeed("epoch", POOL, 8n))).not.toEqual(Buffer.from(base));
  });

  it("uses this program's PDA under test-vrf and ORAO's otherwise", () => {
    const seed = vrfSeed("round", POOL, 1n);
    const test = randomnessAddress(PROGRAM_ID, seed, true);
    const orao = randomnessAddress(PROGRAM_ID, seed, false);
    expect(test.equals(orao)).toBe(false);
    expect(test).toEqual(
      PublicKey.findProgramAddressSync(
        [Buffer.from("test-vrf"), Buffer.from(seed)],
        PROGRAM_ID,
      )[0],
    );
  });

  it("accepts only a fulfilled RandomnessV2 account", () => {
    // [8 discriminator][1 tag][32 client][32 seed][64 randomness]
    const account = Buffer.concat([
      Buffer.from("8befb8d7e356bfe2", "hex"),
      Buffer.from([1]),
      Buffer.alloc(128, 9),
    ]);
    expect(isFulfilled(account)).toBe(true);

    const pending = Buffer.from(account);
    pending[8] = 0;
    expect(isFulfilled(pending)).toBe(false);

    const foreign = Buffer.from(account);
    foreign[0] = 0xff;
    expect(isFulfilled(foreign)).toBe(false);

    expect(isFulfilled(account.subarray(0, account.length - 1))).toBe(false);
    expect(isFulfilled(null)).toBe(false);
  });
});

describe("clockUnixTimestamp", () => {
  it("reads unix_timestamp out of the Clock sysvar", () => {
    const clock = Buffer.alloc(40);
    clock.writeBigInt64LE(1_800_000_000n, 32);
    expect(clockUnixTimestamp(clock)).toBe(1_800_000_000n);
    expect(() => clockUnixTimestamp(undefined)).toThrow(/clock sysvar/);
  });
});
