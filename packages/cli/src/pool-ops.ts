import {
  Keypair,
  PublicKey,
  type PublicKey as PubkeyType,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

import { SYSTEM_PROGRAM, fetchAccount, method } from "./anchor.js";
import { fetchPool, pda, programDataAddress, send, toBn } from "./client.js";
import type { Context, PoolAccount } from "./client.js";
import { assertion, chainError, usage } from "./errors.js";
import { fmtAmount, parseAmount, parsePubkey } from "./parse.js";
import { listPoolFiles, readPoolMints, writePoolMints } from "./state.js";

export interface PoolScoped {
  poolId?: string;
  pool?: string;
}

export function poolIdFrom(opts: PoolScoped): bigint {
  const raw = opts.poolId ?? opts.pool;
  if (!raw) throw usage("pool id required: --pool-id N or the global --pool N");
  return parseAmount(raw, "pool id");
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function initialize(
  ctx: Context,
  opts: {
    guardian: string;
    snapshot: string;
    mockRandomness: string;
    vrfState?: string;
  },
) {
  const config = pda.config();
  const signature = await send(ctx, [
    await method(ctx, "initialize", [
      {
        guardian: parsePubkey(opts.guardian, "--guardian"),
        snapshotAuthority: parsePubkey(opts.snapshot, "--snapshot"),
        mockRandomnessAuthority: parsePubkey(
          opts.mockRandomness,
          "--mock-randomness",
        ),
        // Zero keeps the deployment mock-only (localnet/e2e); the ORAO
        // network-state address enables the `*_with_vrf` settle path.
        vrfRandomnessState: opts.vrfState
          ? parsePubkey(opts.vrfState, "--vrf-state")
          : PublicKey.default,
      },
    ])
      .accounts({
        authority: ctx.wallet.publicKey,
        config,
        program: ctx.programId,
        programData: programDataAddress(ctx.programId),
        systemProgram: SYSTEM_PROGRAM,
      })
      .instruction(),
  ]);
  return {
    signature,
    config: config.toBase58(),
    guardian: opts.guardian,
    snapshotAuthority: opts.snapshot,
    mockRandomnessAuthority: opts.mockRandomness,
  };
}

export async function poolCreate(
  ctx: Context,
  opts: {
    poolId: string;
    mint: string;
    tokenProgram: string;
    minDeposit: string;
    maxStake: string;
    maxBonus: string;
    minEpochSeconds: string;
    maxEpochSeconds: string;
    bufferSeconds: string;
  },
) {
  const poolId = parseAmount(opts.poolId, "--pool-id");
  if (readPoolMints(ctx.stateDir, poolId)) {
    throw assertion(
      `pool ${poolId} already tracked in ${ctx.stateDir}; remove the state file to recreate`,
    );
  }
  const principalMint = Keypair.generate();
  const entryMint = Keypair.generate();
  const pool = pda.pool(poolId);
  const signature = await send(
    ctx,
    [
      await method(ctx, "createPool", [
        {
          poolId: toBn(poolId),
          minDeposit: toBn(parseAmount(opts.minDeposit, "--min-deposit")),
          maxStakePerTile: toBn(parseAmount(opts.maxStake, "--max-stake")),
          maxRoundBonusEntries: toBn(parseAmount(opts.maxBonus, "--max-bonus")),
          minEpochSeconds: toBn(
            parseAmount(opts.minEpochSeconds, "--min-epoch-seconds"),
          ),
          maxEpochSeconds: toBn(
            parseAmount(opts.maxEpochSeconds, "--max-epoch-seconds"),
          ),
          roundCloseBufferSeconds: toBn(
            parseAmount(opts.bufferSeconds, "--buffer-seconds"),
          ),
        },
      ])
        .accounts({
          authority: ctx.wallet.publicKey,
          config: pda.config(),
          pool,
          acceptedMint: parsePubkey(opts.mint, "--mint"),
          acceptedTokenProgram: parsePubkey(
            opts.tokenProgram,
            "--token-program",
          ),
          principalMint: principalMint.publicKey,
          entryMint: entryMint.publicKey,
          principalVault: pda.vault("principal-vault", pool),
          prizeVault: pda.vault("prize-vault", pool),
          jackpotVault: pda.vault("jackpot-vault", pool),
          receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM,
        })
        .instruction(),
    ],
    [principalMint, entryMint],
  );
  const file = writePoolMints(ctx.stateDir, poolId, {
    poolId: poolId.toString(),
    pool: pool.toBase58(),
    acceptedMint: parsePubkey(opts.mint, "--mint").toBase58(),
    principalMint: principalMint.publicKey.toBase58(),
    entryMint: entryMint.publicKey.toBase58(),
    principalMintSecretKey: secretKeyHex(principalMint),
    entryMintSecretKey: secretKeyHex(entryMint),
    createdAt: new Date().toISOString(),
  });
  return {
    signature,
    pool: pool.toBase58(),
    poolId: poolId.toString(),
    principalMint: principalMint.publicKey.toBase58(),
    entryMint: entryMint.publicKey.toBase58(),
    principalVault: pda.vault("principal-vault", pool).toBase58(),
    prizeVault: pda.vault("prize-vault", pool).toBase58(),
    jackpotVault: pda.vault("jackpot-vault", pool).toBase58(),
    stateFile: file,
  };
}

/** hex(secret key) — receipt mints are only ever re-used by hand. */
function secretKeyHex(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString("hex");
}

export async function vaultBalance(
  ctx: Context,
  address: PublicKeyLike,
): Promise<bigint> {
  const res = await ctx.connection.getTokenAccountBalance(address, "finalized");
  return BigInt(res.value.amount);
}

type PublicKeyLike = PubkeyType;

export async function poolShow(ctx: Context, poolId: bigint) {
  const pool = await fetchPool(ctx, poolId);
  const [principal, prize, jackpot] = await Promise.all([
    vaultBalance(ctx, pool.principalVault),
    vaultBalance(ctx, pool.prizeVault),
    vaultBalance(ctx, pool.jackpotVault),
  ]);
  return {
    poolId: pool.poolId.toString(),
    address: pool.address.toBase58(),
    paused: pool.paused,
    acceptedMint: pool.acceptedMint.toBase58(),
    acceptedTokenProgram: pool.acceptedTokenProgram.toBase58(),
    acceptedDecimals: pool.acceptedDecimals,
    principalMint: pool.principalMint.toBase58(),
    entryMint: pool.entryMint.toBase58(),
    principalVault: vaultJson(
      pool.principalVault,
      principal,
      pool.acceptedDecimals,
    ),
    prizeVault: vaultJson(pool.prizeVault, prize, pool.acceptedDecimals),
    jackpotVault: vaultJson(pool.jackpotVault, jackpot, pool.acceptedDecimals),
    limits: {
      minDeposit: pool.minDeposit.toString(),
      maxStakePerTile: pool.maxStakePerTile.toString(),
      maxRoundBonusEntries: pool.maxRoundBonusEntries.toString(),
      minEpochSeconds: pool.minEpochSeconds.toString(),
      maxEpochSeconds: pool.maxEpochSeconds.toString(),
      roundCloseBufferSeconds: pool.roundCloseBufferSeconds.toString(),
    },
    latestEpochId: pool.latestEpochId.toString(),
  };
}

function vaultJson(address: PublicKeyLike, amount: bigint, decimals: number) {
  return {
    address: address.toBase58(),
    atomic: amount.toString(),
    amount: fmtAmount(amount, decimals),
  };
}

export async function status(ctx: Context) {
  const config = await fetchConfig(ctx);
  const pools = [];
  for (const { poolId, file } of listPoolFiles(ctx.stateDir)) {
    const record = readPoolMints(ctx.stateDir, poolId);
    const raw = await fetchAccount(ctx, "pool", pda.pool(poolId)).catch(
      () => null,
    );
    const onChain = raw as Record<string, unknown> | null;
    pools.push({
      poolId: poolId.toString(),
      stateFile: file,
      onChain: onChain !== null,
      paused: onChain ? Boolean(onChain.paused) : undefined,
      latestEpochId: onChain ? String(onChain.latestEpochId) : undefined,
      principalMint: record ? record.principalMint : undefined,
      entryMint: record ? record.entryMint : undefined,
    });
  }
  return { authority: ctx.wallet.publicKey.toBase58(), config, pools };
}

export async function setPause(ctx: Context, mode: string, poolId: bigint) {
  if (mode !== "on" && mode !== "off") throw usage("pause takes `on` or `off`");
  const pool = await fetchPool(ctx, poolId);
  const signature = await send(ctx, [
    await method(ctx, "setPause", [mode === "on"])
      .accounts({
        guardian: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
      })
      .instruction(),
  ]);
  return { signature, pool: pool.address.toBase58(), paused: mode === "on" };
}

export async function fetchConfig(ctx: Context) {
  const address = pda.config();
  const c = await fetchAccount(ctx, "config", address);
  if (!c)
    throw chainError(
      `protocol not initialized (no config at ${address.toBase58()})`,
    );
  return {
    address: address.toBase58(),
    authority: str(c.authority),
    guardian: str(c.guardian),
    snapshotAuthority: str(c.snapshotAuthority),
    mockRandomnessAuthority: str(c.mockRandomnessAuthority),
    productionMode: Boolean(c.productionMode),
  };
}

export function str(value: unknown): string {
  return String(value);
}
