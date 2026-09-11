// spec.md §3.6: stand up a fresh pool on whatever cluster RPC_URL points at.
// Every step checks for the thing before creating it, so a second run creates
// nothing and prints the same block.
//
// Deliberately a plain tsx script, not a Nest standalone context: ConfigModule
// validates HEXUSDC_MINT as required at boot and this is the command that
// creates that mint, so a Nest context cannot start on a fresh cluster. It
// still imports the pure chain modules rather than re-deriving seeds.
//
// stdout carries only the KEY=value block; progress goes to stderr, so
// `bootstrap > pool.env` yields a pasteable file.
import { existsSync } from "node:fs";

import { AnchorProvider, BN, Program, Wallet, Idl } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { parsePoolParams, type PoolParams } from "./bootstrap/params";
import { loadIdl } from "./chain/idl";
import {
  jackpotVaultAddress,
  playerAddress,
  poolAddress,
  principalVaultAddress,
} from "./chain/pda";
import { DEFAULT_PROGRAM_ID } from "./config/env";

/** spec.md §2.5. Pinned on the Pool; the localnet test-vrf build ignores it. */
const DEVNET_VRF_NETWORK_STATE = new PublicKey(
  "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK",
);

const HEXUSDC_DECIMALS = 6;

/** Only the Pool fields this script reads back on a re-run. */
interface PoolAccount {
  authority: PublicKey;
  acceptedMint: PublicKey;
  treasury: PublicKey;
  buybackReserve: PublicKey;
}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Malaysia is UTC+8 and skips daylight saving, so a fixed shift is exact. */
const stamp = (unixSeconds: number): string => {
  const utc = new Date(unixSeconds * 1000).toISOString();
  const myt = new Date((unixSeconds + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return `${utc} (${myt} MYT)`;
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var ${key}`);
  return value;
}

/** Names the failed step so a half-created pool says which half. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`bootstrap failed while ${what}`, { cause });
  }
}

/**
 * The mint is the one piece that must survive between runs, and this script
 * writes no keypair file, so `HEXUSDC_MINT` is the input whenever it is set
 * and a freshly generated mint is only printed for the caller to save.
 */
async function ensureMint(
  connection: Connection,
  authority: Keypair,
  envMint: string | undefined,
): Promise<PublicKey> {
  if (!envMint) {
    const mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      authority.publicKey,
      HEXUSDC_DECIMALS,
    );
    log(`created hexUSDC mint ${mint.toBase58()}`);
    return mint;
  }

  const mint = new PublicKey(envMint);
  const info = await getMint(connection, mint).catch((cause: unknown) => {
    throw new Error(
      `HEXUSDC_MINT ${envMint} is not a mint on this cluster; unset it to create a fresh one`,
      { cause },
    );
  });
  if (info.decimals !== HEXUSDC_DECIMALS) {
    throw new Error(
      `HEXUSDC_MINT ${envMint} has ${info.decimals} decimals, expected ${HEXUSDC_DECIMALS}`,
    );
  }
  // The operator mints the faucet and the simulated yield, so an authority it
  // does not control is a dead pool rather than a warning.
  if (!info.mintAuthority?.equals(authority.publicKey)) {
    throw new Error(
      `HEXUSDC_MINT ${envMint} mint authority is ${info.mintAuthority?.toBase58() ?? "none"}, expected ${authority.publicKey.toBase58()}`,
    );
  }
  log(`hexUSDC mint ${envMint} already exists`);
  return mint;
}

/**
 * Treasury and buyback_reserve share (mint, owner), so they cannot both be
 * the ATA. `createWithSeed` gives each a deterministic address instead of the
 * random keypair the test helper uses, which is what makes a re-run a no-op.
 */
async function ensureSeededTokenAccount(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
  label: string,
  poolId: bigint,
): Promise<PublicKey> {
  const seed = `hexvault-${label}-${poolId}`;
  if (Buffer.byteLength(seed) > 32) {
    throw new Error(
      `POOL_ID ${poolId} makes the ${label} seed "${seed}" longer than 32 bytes`,
    );
  }
  const address = await PublicKey.createWithSeed(
    authority.publicKey,
    seed,
    TOKEN_PROGRAM_ID,
  );
  if (await connection.getAccountInfo(address)) {
    log(`${label} ${address.toBase58()} already exists`);
    return address;
  }

  const lamports =
    await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccountWithSeed({
      fromPubkey: authority.publicKey,
      basePubkey: authority.publicKey,
      seed,
      newAccountPubkey: address,
      lamports,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccount3Instruction(
      address,
      mint,
      authority.publicKey,
      TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  log(`created ${label} ${address.toBase58()}`);
  return address;
}

async function createPool(
  program: Program<Idl>,
  authority: Keypair,
  poolId: bigint,
  pool: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  buybackReserve: PublicKey,
  params: PoolParams,
): Promise<void> {
  // The methods namespace of a generically typed Idl is an index signature,
  // so a stale IDL snapshot shows up here rather than as a decoding failure.
  const createPoolMethod = program.methods.createPool;
  if (!createPoolMethod) {
    throw new Error(
      "the IDL has no create_pool instruction; run `pnpm --filter @hexvault/backend sync-idl`",
    );
  }

  await createPoolMethod({
    poolId: new BN(poolId.toString()),
    vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
    epochSeconds: new BN(params.epochSeconds),
    epochAnchor: new BN(params.epochAnchor),
    roundSeconds: new BN(params.roundSeconds),
    closeBuffer: new BN(params.closeBuffer),
    vrfTimeout: new BN(params.vrfTimeout),
    minDeposit: new BN(params.minDeposit.toString()),
    houseCutBps: params.houseCutBps,
  })
    .accountsPartial({
      authority: authority.publicKey,
      pool,
      acceptedMint: mint,
      principalVault: principalVaultAddress(program.programId, pool),
      jackpotVault: jackpotVaultAddress(program.programId, pool),
      house: playerAddress(program.programId, pool, authority.publicKey),
      treasury,
      buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();
  log(
    `created pool ${pool.toBase58()} (epoch ${params.epochSeconds}s, round ${params.roundSeconds}s)`,
  );
  // Print the grid the anchor produces, so a mistyped anchor is obvious now
  // rather than a week later when the draws land at the wrong hour.
  const now = Math.floor(Date.now() / 1000);
  const period = params.epochSeconds;
  // Math.floor matches Rust's div_euclid for a positive period, so an anchor
  // still in the future floors downward instead of toward zero.
  const next =
    params.epochAnchor +
    (Math.floor((now - params.epochAnchor) / period) + 1) * period;
  log(`  epoch anchor ${stamp(params.epochAnchor)}`);
  for (const k of [0, 1, 2]) {
    log(`  boundary ${k + 1} ${stamp(next + k * period)}`);
  }
}

async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  const params = parsePoolParams(process.argv.slice(2));
  const connection = new Connection(requireEnv("RPC_URL"), "confirmed");
  const authority = Keypair.fromSecretKey(
    bs58.decode(requireEnv("AUTHORITY_KEYPAIR")),
  );
  const programId = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
  const poolId = BigInt(process.env.POOL_ID ?? "1");
  log(
    `authority ${authority.publicKey.toBase58()} on ${connection.rpcEndpoint}`,
  );

  // The env-resolved program id wins over the checked-in IDL snapshot's
  // address, same as ChainService.
  const idl = { ...loadIdl(), address: programId.toBase58() };
  const program = new Program(
    idl,
    new AnchorProvider(connection, new Wallet(authority), {
      commitment: "confirmed",
    }),
  );

  const pool = poolAddress(programId, poolId);
  const existing = await step("reading the pool account", async () => {
    const info = await connection.getAccountInfo(pool);
    // "pool", not "Pool": Program camelCases every IDL name on construction.
    // `decode` checks the discriminator, so a wrong key fails loudly here.
    return info
      ? program.coder.accounts.decode<PoolAccount>("pool", info.data)
      : null;
  });
  if (existing && !existing.authority.equals(authority.publicKey)) {
    throw new Error(
      `pool ${pool.toBase58()} belongs to ${existing.authority.toBase58()}, not to AUTHORITY_KEYPAIR`,
    );
  }

  // An existing pool has already recorded which mint and which token accounts
  // it accepts, so those win over anything this run would otherwise derive.
  const envMint = process.env.HEXUSDC_MINT;
  if (
    existing &&
    envMint &&
    !existing.acceptedMint.equals(new PublicKey(envMint))
  ) {
    throw new Error(
      `pool ${pool.toBase58()} accepts ${existing.acceptedMint.toBase58()}, but HEXUSDC_MINT is ${envMint}`,
    );
  }
  const mint = existing
    ? existing.acceptedMint
    : await step("creating the hexUSDC mint", () =>
        ensureMint(connection, authority, envMint),
      );

  const authorityAta = await step(
    "creating the authority ATA",
    async () =>
      (
        await getOrCreateAssociatedTokenAccount(
          connection,
          authority,
          mint,
          authority.publicKey,
        )
      ).address,
  );

  const treasury = existing
    ? existing.treasury
    : await step("creating the treasury", () =>
        ensureSeededTokenAccount(
          connection,
          authority,
          mint,
          "treasury",
          poolId,
        ),
      );
  const buybackReserve = existing
    ? existing.buybackReserve
    : await step("creating the buyback reserve", () =>
        ensureSeededTokenAccount(
          connection,
          authority,
          mint,
          "buyback",
          poolId,
        ),
      );

  if (existing) {
    log(`pool ${pool.toBase58()} already exists`);
  } else {
    await step("calling create_pool", () =>
      createPool(
        program,
        authority,
        poolId,
        pool,
        mint,
        treasury,
        buybackReserve,
        params,
      ),
    );
  }

  process.stdout.write(
    [
      `HEXUSDC_MINT=${mint.toBase58()}`,
      `PROGRAM_ID=${programId.toBase58()}`,
      `POOL_ID=${poolId}`,
      `POOL_ADDRESS=${pool.toBase58()}`,
      `PRINCIPAL_VAULT=${principalVaultAddress(programId, pool).toBase58()}`,
      `JACKPOT_VAULT=${jackpotVaultAddress(programId, pool).toBase58()}`,
      `TREASURY=${treasury.toBase58()}`,
      `BUYBACK_RESERVE=${buybackReserve.toBase58()}`,
      `AUTHORITY_ATA=${authorityAta.toBase58()}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  // Print the whole cause chain: the outer message names the step, the
  // innermost names the RPC or program error.
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `bootstrap: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
});
