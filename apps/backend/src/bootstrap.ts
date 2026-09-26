// spec.md §3.6: stand up a fresh pool on whatever cluster RPC_URL points at.
// Every step checks for the thing before creating it, so a second run creates
// nothing and prints the same block.
//
// Deliberately a plain tsx script, not a Nest standalone context: ConfigModule
// validates ACCEPTED_MINT as required at boot and this is the command that
// creates that mint, so a Nest context cannot start on a fresh cluster. It
// still imports the pure chain modules rather than re-deriving seeds.
//
// stdout carries only the KEY=value block; progress goes to stderr, so
// `bootstrap > pool.env` yields a pasteable file.
import { existsSync } from "node:fs";

import { AnchorProvider, BN, Program, Wallet, Idl } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  unpackAccount,
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
  admin: PublicKey;
  operator: PublicKey;
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
 * writes no keypair file, so `ACCEPTED_MINT` is the input whenever it is set
 * and a freshly generated mint is only printed for the caller to save.
 *
 * Creating one needs this key to be the mint authority; taking one that
 * already exists does not. Real USDC on mainnet has an authority nobody here
 * holds, and that is the normal case, not an error: it only means the faucet
 * and every other mint call stay off.
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
    log(`created mint ${mint.toBase58()}`);
    return mint;
  }

  const mint = new PublicKey(envMint);
  const info = await getMint(connection, mint).catch((cause: unknown) => {
    throw new Error(
      `ACCEPTED_MINT ${envMint} is not a mint on this cluster; unset it to create a fresh one`,
      { cause },
    );
  });
  if (info.decimals !== HEXUSDC_DECIMALS) {
    throw new Error(
      `ACCEPTED_MINT ${envMint} has ${info.decimals} decimals, expected ${HEXUSDC_DECIMALS}`,
    );
  }
  if (!info.mintAuthority?.equals(authority.publicKey)) {
    log(
      `mint ${envMint} is controlled by ${info.mintAuthority?.toBase58() ?? "nobody"}, not by this key: no faucet, no minting`,
    );
    return mint;
  }
  log(`mint ${envMint} already exists`);
  return mint;
}

/**
 * Treasury and buyback_reserve share (mint, owner), so they cannot both be
 * the ATA. `createWithSeed` gives each a deterministic address instead of the
 * random keypair the test helper uses, which is what makes a re-run a no-op.
 * The seed carries the Pool PDA, not just POOL_ID: the same authority
 * bootstrapping pool 1 on a second program ID would otherwise land on the
 * first program's treasury, whose mint differs (MintMismatch in create_pool).
 */
async function ensureSeededTokenAccount(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
  label: string,
  pool: PublicKey,
): Promise<PublicKey> {
  // Seeds cap at 32 bytes: "treasury-" plus 16 base58 chars of the pool.
  const seed = `${label}-${pool.toBase58().slice(0, 16)}`;
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

/**
 * A token account the caller already holds, passed as `--treasury` or
 * `--buyback-reserve`: on mainnet the Admin multisig's own accounts
 * (CONTEXT.md "Treasury"), which nothing here can or should create. Checked
 * against the same rule `create_pool` applies (the mint must match) plus the
 * one it cannot apply for us, that the account exists at all, so a typo
 * fails here instead of as MintMismatch after the House Player is funded.
 * The owner is only logged: the program never checks it, and this is the
 * one place a human sees which key will hold the House's prize share.
 */
async function resolveTokenAccount(
  connection: Connection,
  mint: PublicKey,
  label: string,
  address: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(address);
  if (!info) {
    throw new Error(
      `--${label} ${address.toBase58()} does not exist on this cluster`,
    );
  }
  if (
    !info.owner.equals(TOKEN_PROGRAM_ID) &&
    !info.owner.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `--${label} ${address.toBase58()} is not a token account (owned by ${info.owner.toBase58()})`,
    );
  }
  const account = unpackAccount(address, info, info.owner);
  if (!account.mint.equals(mint)) {
    throw new Error(
      `--${label} ${address.toBase58()} holds ${account.mint.toBase58()}, not the accepted mint ${mint.toBase58()}`,
    );
  }
  log(
    `${label} ${address.toBase58()} exists, owned by ${account.owner.toBase58()}`,
  );
  return address;
}

async function createPool(
  program: Program<Idl>,
  payer: Keypair,
  roles: { admin: PublicKey; operator: PublicKey },
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
    admin: roles.admin,
    operator: roles.operator,
    vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
    epochSeconds: new BN(params.epochSeconds),
    epochAnchor: new BN(params.epochAnchor),
    roundSeconds: new BN(params.roundSeconds),
    closeBuffer: new BN(params.closeBuffer),
    vrfTimeout: new BN(params.vrfTimeout),
    minDeposit: new BN(params.minDeposit.toString()),
    houseCutBps: params.houseCutBps,
    minJackpot: new BN(params.minJackpot.toString()),
    registrationWindow: new BN(params.registrationWindow),
    payoutTimeout: new BN(params.payoutTimeout),
    baseRateBps: params.baseRateBps,
    ticketsPerUsdc: params.ticketsPerUsdc,
    bonusCapBps: params.bonusCapBps,
  })
    .accountsPartial({
      payer: payer.publicKey,
      pool,
      acceptedMint: mint,
      principalVault: principalVaultAddress(program.programId, pool),
      jackpotVault: jackpotVaultAddress(program.programId, pool),
      house: playerAddress(program.programId, pool, roles.operator),
      treasury,
      buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
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
    bs58.decode(requireEnv("OPERATOR_KEYPAIR")),
  );
  // The loaded key pays, mints and owns the token accounts. It is the
  // operator unless --operator says otherwise, and the admin only when
  // neither --admin nor ADMIN_ADDRESS names someone else.
  const roles = {
    admin:
      params.admin ??
      (process.env.ADMIN_ADDRESS
        ? new PublicKey(process.env.ADMIN_ADDRESS)
        : authority.publicKey),
    operator: params.operator ?? authority.publicKey,
  };
  const programId = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
  const poolId = BigInt(process.env.POOL_ID ?? "1");
  log(
    // Host only: a keyed RPC URL carries its api key in the query string.
    `signer ${authority.publicKey.toBase58()} on ${new URL(connection.rpcEndpoint).host}`,
  );
  log(
    `admin ${roles.admin.toBase58()}, operator ${roles.operator.toBase58()}`,
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
  if (existing && !existing.operator.equals(roles.operator)) {
    throw new Error(
      `pool ${pool.toBase58()} is cranked by ${existing.operator.toBase58()}, not by ${roles.operator.toBase58()}`,
    );
  }

  // An existing pool has already recorded which mint and which token accounts
  // it accepts, so those win over anything this run would otherwise derive.
  const envMint = process.env.ACCEPTED_MINT ?? process.env.HEXUSDC_MINT;
  if (
    existing &&
    envMint &&
    !existing.acceptedMint.equals(new PublicKey(envMint))
  ) {
    throw new Error(
      `pool ${pool.toBase58()} accepts ${existing.acceptedMint.toBase58()}, but ACCEPTED_MINT is ${envMint}`,
    );
  }
  const mint = existing
    ? existing.acceptedMint
    : await step("resolving the accepted mint", () =>
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

  // Read once, here: it decides below whether this key may seed the two
  // protocol token accounts, and it is printed again at the end.
  const mintAuthority = await step(
    "reading the mint authority",
    async () => (await getMint(connection, mint)).mintAuthority,
  );
  const signerControlsMint = mintAuthority?.equals(authority.publicKey) ?? false;

  // The pool records which token accounts it pays the House's prize share
  // into, so an existing pool's win over the flags, and a flag that names a
  // different account is a mistake worth stopping on, same as ACCEPTED_MINT.
  for (const [label, given, recorded] of [
    ["treasury", params.treasury, existing?.treasury],
    ["buyback-reserve", params.buybackReserve, existing?.buybackReserve],
  ] as const) {
    if (existing && given && recorded && !given.equals(recorded)) {
      throw new Error(
        `pool ${pool.toBase58()} already records ${label} ${recorded.toBase58()}, but --${label} is ${given.toBase58()}`,
      );
    }
  }
  // Seeding creates accounts owned by this hot key. That is right for a test
  // mint this key controls (devnet, staging, localnet) and wrong for real
  // USDC: the accounts then must be the Admin multisig's (CONTEXT.md
  // "Treasury", docs/architecture.md), which only --treasury and
  // --buyback-reserve can name. So an external mint requires both flags
  // rather than quietly parking the prize share under the operator key.
  if (
    !existing &&
    !signerControlsMint &&
    (params.treasury === undefined || params.buybackReserve === undefined)
  ) {
    throw new Error(
      `mint ${mint.toBase58()} is controlled by ${mintAuthority?.toBase58() ?? "nobody"}, not by this key, so bootstrap will not seed hot-key-owned token accounts for it; pass --treasury and --buyback-reserve (token accounts for that mint, on mainnet the Admin multisig's)`,
    );
  }

  const givenTreasury = params.treasury;
  const givenBuyback = params.buybackReserve;
  const treasury = existing
    ? existing.treasury
    : givenTreasury !== undefined
      ? await step("checking the treasury", () =>
          resolveTokenAccount(connection, mint, "treasury", givenTreasury),
        )
      : await step("creating the treasury", () =>
          ensureSeededTokenAccount(
            connection,
            authority,
            mint,
            "treasury",
            pool,
          ),
        );
  const buybackReserve = existing
    ? existing.buybackReserve
    : givenBuyback !== undefined
      ? await step("checking the buyback reserve", () =>
          resolveTokenAccount(
            connection,
            mint,
            "buyback-reserve",
            givenBuyback,
          ),
        )
      : await step("creating the buyback reserve", () =>
          ensureSeededTokenAccount(
            connection,
            authority,
            mint,
            "buyback",
            pool,
          ),
        );
  if (!existing && treasury.equals(buybackReserve)) {
    // The program allows it (two transfers to one account), but the 20/50
    // split then lands in one balance and the buyback earmark is lost.
    log(
      `warning: treasury and buyback reserve are the same account ${treasury.toBase58()}`,
    );
  }

  if (existing) {
    log(`pool ${pool.toBase58()} already exists`);
  } else {
    await step("calling create_pool", () =>
      createPool(
        program,
        authority,
        roles,
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
      `ACCEPTED_MINT=${mint.toBase58()}`,
      `MINT_AUTHORITY=${mintAuthority?.toBase58() ?? "none"}`,
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

  if (!mintAuthority?.equals(authority.publicKey)) {
    log(
      `mint ${mint.toBase58()} is controlled by ${mintAuthority?.toBase58() ?? "nobody"}, not by ${authority.publicKey.toBase58()}: no faucet, no minting`,
    );
  }
}

main().catch((error: unknown) => {
  // Print the whole cause chain: the outer message names the step, the
  // innermost names the RPC or program error.
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `bootstrap: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
});
