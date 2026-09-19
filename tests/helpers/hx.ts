// Shared plumbing every localnet suite needs: the provider/program, PDA
// derivers, and account bootstrap. Test files call
// `program.methods.x().accounts({...}).rpc()` directly instead of going
// through a per-instruction wrapper.

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAccount,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, BN, EventParser, Program, Wallet } from "@anchor-lang/core";
import idl from "../../target/idl/hex_vault.json";

const secret = Uint8Array.from(
  JSON.parse(readFileSync(process.env.ANCHOR_WALLET as string, "utf8")),
);
const connection = new Connection(process.env.ANCHOR_PROVIDER_URL as string, "confirmed");

export const provider = new AnchorProvider(connection, new Wallet(Keypair.fromSecretKey(secret)), {
  commitment: "confirmed",
});

export const program = new Program(idl as typeof idl, provider);
export const PROGRAM_ID = program.programId;

// Pinned on every pool at create_pool; test-vrf never reads it, since
// test_fulfill fabricates the randomness account directly.
export const DEVNET_VRF_NETWORK_STATE = new PublicKey(
  "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK",
);
// ORAO's fee treasury on devnet (`network_state.config.treasury`, read
// 2026-09-05). Forwarded on every request; ORAO rejects any other account.
// test-vrf never touches it either, any pubkey would do on localnet.
export const DEVNET_VRF_TREASURY = new PublicKey(
  "9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR",
);

function u64le(n: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function poolPda(poolId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), u64le(poolId)], PROGRAM_ID)[0];
}

export function playerPda(pool: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("player"), pool.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function epochPda(pool: PublicKey, epochId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), pool.toBuffer(), u64le(epochId)],
    PROGRAM_ID,
  )[0];
}

export function roundPda(pool: PublicKey, roundId: bigint | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), pool.toBuffer(), u64le(roundId)],
    PROGRAM_ID,
  )[0];
}

export function positionPda(round: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), round.toBuffer(), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function principalVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("principal"), pool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function jackpotVaultPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot"), pool.toBuffer()], PROGRAM_ID)[0];
}

/** The test-vrf stand-in PDA for a request seed (see vrf::randomness_address). */
export function randomnessPda(seed: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("test-vrf"), Buffer.from(seed)],
    PROGRAM_ID,
  )[0];
}

/**
 * Fabricates a fulfilled randomness account for `seed` and returns its
 * address, which the settle instruction expects to be handed.
 *
 * Read the seed off the account being settled (`round.vrfSeed`,
 * `epoch.vrfSeed`) rather than recomputing the keccak here: the program is
 * the authority on it, and tests then need no hash library.
 */
export async function fulfillRandomness(
  seed: Uint8Array | number[],
  randomness: Uint8Array | number[] = new Uint8Array(64).fill(7),
): Promise<PublicKey> {
  const seedBytes = Uint8Array.from(seed);
  const account = randomnessPda(seedBytes);
  await program.methods
    .testFulfill(Array.from(seedBytes), Array.from(Uint8Array.from(randomness)))
    .accountsPartial({
      payer: provider.wallet.publicKey,
      randomness: account,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return account;
}

/**
 * 64 randomness bytes whose leading LE u64 is `value`, so a test can pick the
 * winning tile or draw target instead of guessing what the oracle returns.
 */
export function randomnessFor(value: bigint | number): Uint8Array {
  const bytes = new Uint8Array(64).fill(0);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` until it stops throwing. The localnet validator's on-chain
 * clock does not track wall-clock time closely enough to compute a sleep
 * duration from an `i64` unix-seconds deadline and `Date.now()` (observed
 * lagging real time by a few seconds over a short epoch), so every
 * time-gated instruction (an epoch or round boundary, a vrf timeout) is
 * driven by polling instead of a single calculated sleep.
 */
export async function retryUntilOk<T>(
  fn: () => Promise<T>,
  intervalMs = 750,
  maxAttempts = 120,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError;
}

/** The validator's actual on-chain clock (not `Date.now()`, which drifts a
 * few seconds from it and so is an unreliable proxy over a short window). */
export async function onChainNowSeconds(): Promise<number> {
  for (;;) {
    const slot = await connection.getSlot();
    const time = await connection.getBlockTime(slot);
    if (time !== null) return time;
    await sleep(200);
  }
}

/** Blocks until the validator's own clock reaches `targetUnixSeconds`. */
export async function sleepUntilOnChain(targetUnixSeconds: number): Promise<void> {
  while ((await onChainNowSeconds()) < targetUnixSeconds) {
    await sleep(500);
  }
}

/** Decodes the named event out of one confirmed transaction's logs. */
export async function findEvent<T = unknown>(
  signature: string,
  name: string,
): Promise<T | undefined> {
  const tx = await provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  const parser = new EventParser(program.programId, program.coder);
  for (const event of parser.parseLogs(logs)) {
    if (event.name === name) return event.data as T;
  }
  return undefined;
}

async function airdrop(to: PublicKey, sol: number): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// Unique per call and per process. Vitest gives each test file its own
// worker, and two workers reaching setupPool() in the same millisecond used
// to derive the same pool PDA: preflight passed for both, then the second
// `create_pool` failed on chain with the account already in use.
const poolNonce = BigInt(process.pid % 1_000);
let poolCounter = 0;
/** Exported for the few tests that call `create_pool` themselves instead of
 *  going through `setupPool`. */
export function nextPoolId(): bigint {
  poolCounter += 1;
  return BigInt(Date.now()) * 1_000_000n + poolNonce * 1_000n + BigInt(poolCounter);
}

export interface PoolParamsOverrides {
  epochSeconds?: number;
  /** Phase of the epoch grid. Defaults to the on-chain clock at pool
   * creation, which puts the first grid point one whole `epochSeconds`
   * after bootstrap, so epoch 1 is as long as it was before the grid
   * existed bar the seconds the test spends setting wallets up. */
  epochAnchor?: number;
  roundSeconds?: number;
  closeBuffer?: number;
  vrfTimeout?: number;
  minDeposit?: number;
  /** House cut in basis points, 0..=10_000. Defaults to the bootstrap rate,
   * so every round test settles against the cut the product ships with. */
  houseCutBps?: number;
  /** Jackpot floor below which `close_registration` rolls the epoch over.
   * Defaults to 0 (no floor) so a test that never funds the jackpot still
   * reaches the draw; the low-jackpot test sets it. */
  minJackpot?: number;
  /** Seconds past `ends_at` before `close_registration` is accepted.
   * Defaults to 0, so every suite keeps the timing it had before the window
   * existed; the window test sets it. */
  registrationWindow?: number;
  /** Seconds a Drawn epoch waits for its payout before `rollover_epoch` will
   * take it. Defaults to a day, well past any test's run. */
  payoutTimeout?: number;
  /** Reuse an existing mint instead of creating a fresh one (e.g. to test
   * two pools sharing an accepted asset). The caller must not rely on this
   * pool's operator being the mint authority when a shared mint is passed. */
  mint?: PublicKey;
}

// Spec §7 defaults.
const DEFAULT_PARAMS = {
  epochSeconds: 86_400,
  roundSeconds: 60,
  closeBuffer: 5,
  vrfTimeout: 120,
  minDeposit: 1_000_000, // 1 hexUSDC at 6 decimals
  houseCutBps: 600, // 6%, the bootstrap default
  minJackpot: 0,
  registrationWindow: 0,
  payoutTimeout: 86_400,
};

export interface PoolCtx {
  poolId: bigint;
  pool: PublicKey;
  mint: PublicKey;
  epochSeconds: number;
  epochAnchor: number;
  /** Signs set_params, unpause, set_operator and propose_admin. */
  admin: Keypair;
  /** Signs every crank, owns the House, funds the wallets, mints the asset. */
  operator: Keypair;
  treasury: PublicKey;
  buybackReserve: PublicKey;
  principalVault: PublicKey;
  jackpotVault: PublicKey;
  house: PublicKey;
  minDeposit: bigint;
  houseCutBps: number;
  /** A fresh funded keypair with `amount` hexUSDC already in its ATA. */
  fundedWallet(amount: bigint): Promise<{ keypair: Keypair; tokenAccount: PublicKey }>;
}

/**
 * Airdrops, mints a fresh hexUSDC mint, wires up treasury/buyback token
 * accounts, and calls `create_pool`. Admin and operator are two distinct
 * fresh keypairs (neither is the test wallet), so every role-gated
 * instruction can be tested with the right key and with the wrong one.
 */
export async function setupPool(overrides: PoolParamsOverrides = {}): Promise<PoolCtx> {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const poolId = nextPoolId();

  const admin = Keypair.generate();
  const operator = Keypair.generate();
  await airdrop(admin.publicKey, 10);
  await airdrop(operator.publicKey, 10);

  const mint = overrides.mint ?? (await createMint(connection, operator, operator.publicKey, null, 6));
  // Two independent token accounts, both owned by the operator. They must be
  // plain accounts with their own keypairs: `createAccount` without one
  // derives the ATA, and treasury and buyback_reserve share (mint, owner),
  // so the second call would land on the address the first already took.
  const treasury = await createAccount(
    connection,
    operator,
    mint,
    operator.publicKey,
    Keypair.generate(),
  );
  const buybackReserve = await createAccount(
    connection,
    operator,
    mint,
    operator.publicKey,
    Keypair.generate(),
  );

  const pool = poolPda(poolId);
  const principalVault = principalVaultPda(pool);
  const jackpotVault = jackpotVaultPda(pool);
  const house = playerPda(pool, operator.publicKey);
  const epochAnchor = overrides.epochAnchor ?? (await onChainNowSeconds());

  await program.methods
    .createPool({
      poolId: new BN(poolId.toString()),
      admin: admin.publicKey,
      operator: operator.publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      epochSeconds: new BN(params.epochSeconds),
      epochAnchor: new BN(epochAnchor),
      roundSeconds: new BN(params.roundSeconds),
      closeBuffer: new BN(params.closeBuffer),
      vrfTimeout: new BN(params.vrfTimeout),
      minDeposit: new BN(params.minDeposit),
      houseCutBps: params.houseCutBps,
      minJackpot: new BN(params.minJackpot),
      registrationWindow: new BN(params.registrationWindow),
      payoutTimeout: new BN(params.payoutTimeout),
    })
    .accountsPartial({
      payer: operator.publicKey,
      pool,
      acceptedMint: mint,
      principalVault,
      jackpotVault,
      house,
      treasury,
      buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([operator])
    .rpc();

  async function fundedWallet(amount: bigint) {
    const keypair = Keypair.generate();
    await airdrop(keypair.publicKey, 5);
    const ata = await getOrCreateAssociatedTokenAccount(connection, operator, mint, keypair.publicKey);
    if (amount > 0n) {
      await mintTo(connection, operator, mint, ata.address, operator, amount);
    }
    return { keypair, tokenAccount: ata.address };
  }

  return {
    poolId,
    pool,
    mint,
    epochSeconds: params.epochSeconds,
    epochAnchor,
    admin,
    operator,
    treasury,
    buybackReserve,
    principalVault,
    jackpotVault,
    house,
    minDeposit: BigInt(params.minDeposit),
    houseCutBps: params.houseCutBps,
    fundedWallet,
  };
}
