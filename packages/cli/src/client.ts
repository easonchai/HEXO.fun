import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";

import { fetchAccount } from "./anchor.js";
import { chainError, usage } from "./errors.js";
import { parsePubkey } from "./parse.js";

// @anchor-lang/core ships CJS only: its named value exports are not detectable
// from ESM, so destructure the default export for values and keep named
// type-only imports for types.
import anchorCore from "@anchor-lang/core";
import type {
  AnchorProvider as AnchorProviderType,
  BN as BNType,
  Program as ProgramType,
} from "@anchor-lang/core";
const { AnchorProvider, Program, Wallet, BN } = anchorCore;

export const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

/** Walks up to the repo's target/idl unless HEXVAULT_IDL is set. */
export function resolveIdlPath(): string {
  if (process.env.HEXVAULT_IDL) return process.env.HEXVAULT_IDL;
  let dir = import.meta.dirname!;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "target", "idl", "hex_vault.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw usage(
    "IDL not found: set HEXVAULT_IDL to target/idl/hex_vault.json (anchor build first)",
  );
}

export function loadIdl(): { address: string } & Record<string, unknown> {
  const file = resolveIdlPath();
  return JSON.parse(fs.readFileSync(file, "utf8")) as {
    address: string;
  } & Record<string, unknown>;
}

export function loadKeypair(file?: string): Keypair {
  const resolved =
    file ?? process.env.HEXVAULT_KEYPAIR ?? "~/.config/solana/id.json";
  const expanded = resolved.startsWith("~")
    ? path.join(process.env.HOME ?? "", resolved.slice(1))
    : resolved;
  if (!fs.existsSync(expanded)) {
    throw usage(
      `keypair not found: ${expanded} (use --keypair or HEXVAULT_KEYPAIR)`,
    );
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expanded, "utf8")) as number[]),
  );
}

export interface GlobalOptions {
  url: string;
  keypair?: string;
  stateDir?: string;
  pool?: string;
}

export interface Context {
  connection: Connection;
  wallet: Keypair;
  provider: AnchorProviderType;
  program: ProgramType;
  programId: PublicKey;
  stateDir: string;
  json: boolean;
}

export function stateDirectory(opts: GlobalOptions): string {
  if (opts.stateDir) return path.resolve(opts.stateDir);
  if (process.env.HEXVAULT_STATE_DIR)
    return path.resolve(process.env.HEXVAULT_STATE_DIR);
  // packages/cli/src -> repo root
  return path.resolve(import.meta.dirname!, "..", "..", "..", ".hexvault");
}

export function createContext(opts: GlobalOptions, json: boolean): Context {
  const wallet = loadKeypair(opts.keypair);
  const connection = new Connection(opts.url, "finalized");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "finalized",
  });
  const idl = loadIdl();
  const programId = parsePubkey(idl.address as string, "idl.address");
  const program = new Program(idl as never, provider) as unknown as ProgramType;
  return {
    connection,
    wallet,
    provider,
    program,
    programId,
    stateDir: stateDirectory(opts),
    json,
  };
}

export function le8(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function find(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID_PLACEHOLDER)[0]!;
}

let PROGRAM_ID_PLACEHOLDER = PublicKey.default;

/** PDAs, all derived with the deployed program id. */
export const pda = {
  bind(programId: PublicKey): void {
    PROGRAM_ID_PLACEHOLDER = programId;
  },
  config(): PublicKey {
    return find([Buffer.from("config")]);
  },
  pool(poolId: bigint): PublicKey {
    return find([Buffer.from("pool"), le8(poolId)]);
  },
  epoch(poolKey: PublicKey, epochId: bigint): PublicKey {
    return find([Buffer.from("epoch"), poolKey.toBuffer(), le8(epochId)]);
  },
  round(poolKey: PublicKey, epochId: bigint, roundId: bigint): PublicKey {
    return find([
      Buffer.from("round"),
      poolKey.toBuffer(),
      le8(epochId),
      le8(roundId),
    ]);
  },
  player(poolKey: PublicKey, owner: PublicKey): PublicKey {
    return find([Buffer.from("player"), poolKey.toBuffer(), owner.toBuffer()]);
  },
  position(
    poolKey: PublicKey,
    roundKey: PublicKey,
    owner: PublicKey,
  ): PublicKey {
    return find([
      Buffer.from("position"),
      poolKey.toBuffer(),
      roundKey.toBuffer(),
      owner.toBuffer(),
    ]);
  },
  request(poolKey: PublicKey, subject: PublicKey, kind: number): PublicKey {
    return find([
      Buffer.from("randomness"),
      poolKey.toBuffer(),
      subject.toBuffer(),
      Buffer.from([kind]),
    ]);
  },
  vault(seed: string, poolKey: PublicKey): PublicKey {
    return find([Buffer.from(seed), poolKey.toBuffer()]);
  },
  programData(programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE,
    )[0]!;
  },
};

export function programDataAddress(programId: PublicKey): PublicKey {
  return pda.programData(programId);
}

/** Sends, waits for `finalized`, and returns the signature. */
export async function send(
  ctx: Context,
  instructions: TransactionInstructionLike[],
  extraSigners: Keypair[] = [],
): Promise<string> {
  const tx = new Transaction();
  for (const ix of instructions) tx.add(ix as never);
  if (tx.recentBlockhash === undefined) {
    const { blockhash } = await ctx.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = ctx.wallet.publicKey;
  }
  let signature: string;
  try {
    signature = await ctx.connection.sendTransaction(
      tx,
      [ctx.wallet, ...extraSigners],
      {
        skipPreflight: false,
      },
    );
  } catch (err) {
    throw chainError(await describeChainError(err));
  }
  try {
    await ctx.connection.confirmTransaction(signature, "finalized");
  } catch (err) {
    throw chainError(
      `transaction ${signature} not finalized: ${describeChainError(err)}`,
    );
  }
  return signature;
}

type TransactionInstructionLike = {
  keys: unknown[];
  programId: PublicKey;
  data: Buffer;
};

export async function describeChainError(err: unknown): Promise<string> {
  const e = err as {
    message?: string;
    logs?: string[];
    transactionError?: unknown;
    getLogs?: () => Promise<string[]>;
  };
  let logs = Array.isArray(e?.logs) ? e.logs : undefined;
  if (!logs && typeof e?.getLogs === "function") {
    // SendTransactionError keeps preflight logs behind an async accessor.
    try {
      logs = await e.getLogs();
    } catch {
      logs = undefined;
    }
  }
  const msg = e?.message ?? String(err);
  return logs && logs.length > 0 ? `${msg}\n${logs.join("\n")}` : msg;
}

export function toBn(v: bigint): BNType {
  return new BN(v.toString());
}

export interface PoolAccount {
  address: PublicKey;
  poolId: bigint;
  paused: boolean;
  acceptedMint: PublicKey;
  acceptedTokenProgram: PublicKey;
  acceptedDecimals: number;
  principalMint: PublicKey;
  entryMint: PublicKey;
  principalVault: PublicKey;
  prizeVault: PublicKey;
  jackpotVault: PublicKey;
  minDeposit: bigint;
  maxStakePerTile: bigint;
  maxRoundBonusEntries: bigint;
  minEpochSeconds: bigint;
  maxEpochSeconds: bigint;
  roundCloseBufferSeconds: bigint;
  latestEpochId: bigint;
}

/** Fetches + decodes the pool, or fails with a chain error. */
export async function fetchPool(
  ctx: Context,
  poolId: bigint,
): Promise<PoolAccount> {
  const address = pda.pool(poolId);
  const account = await fetchAccount(ctx, "pool", address);
  if (!account)
    throw chainError(`pool ${poolId} does not exist at ${address.toBase58()}`);
  const key = (name: string) => parsePubkey(String(account[name]));
  const big = (name: string) => BigInt(String(account[name]));
  return {
    address,
    poolId: big("poolId"),
    paused: Boolean(account.paused),
    acceptedMint: key("acceptedMint"),
    acceptedTokenProgram: key("acceptedTokenProgram"),
    acceptedDecimals: Number(account.acceptedDecimals),
    principalMint: key("principalMint"),
    entryMint: key("entryMint"),
    principalVault: key("principalVault"),
    prizeVault: key("prizeVault"),
    jackpotVault: key("jackpotVault"),
    minDeposit: big("minDeposit"),
    maxStakePerTile: big("maxStakePerTile"),
    maxRoundBonusEntries: big("maxRoundBonusEntries"),
    minEpochSeconds: big("minEpochSeconds"),
    maxEpochSeconds: big("maxEpochSeconds"),
    roundCloseBufferSeconds: big("roundCloseBufferSeconds"),
    latestEpochId: big("latestEpochId"),
  };
}

export function ata(
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, programId);
}

/** Creates the ATA when missing; cheap insurance for instructions without `associated_token_program`. */
export async function ensureAta(
  ctx: Context,
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey,
): Promise<PublicKey> {
  const address = ata(mint, owner, programId);
  const info = await ctx.connection.getAccountInfo(address);
  if (info) return address;
  await getOrCreateAssociatedTokenAccount(
    ctx.connection,
    ctx.wallet,
    mint,
    owner,
    false,
    "finalized",
    { commitment: "finalized", preflightCommitment: "finalized" },
    programId,
  );
  return address;
}
