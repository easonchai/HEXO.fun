import { randomBytes } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import {
  SYSTEM_PROGRAM,
  fetchAccount,
  fetchAccountStrict,
  method,
} from "./anchor.js";
import { ata, ensureAta, fetchPool, pda, send, toBn } from "./client.js";
import type { Context } from "./client.js";
import { chainError } from "./errors.js";
import {
  fmtAmount,
  fmtTiles,
  parseAmount,
  parseHash,
  parsePubkey,
  parseTiles,
  parseTime,
} from "./parse.js";
import { str } from "./pool-ops.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const SLOTHASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111",
);
export const ORAO_VRF_PROGRAM_ID = new PublicKey(
  "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y",
);

/** ORAO network-state PDA (its address is what `initialize --vrf-state` sets). */
export function oraoNetworkStateAddress(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("orao-vrf-network-configuration")],
    ORAO_VRF_PROGRAM_ID,
  )[0];
}

/** ORAO request PDA for one of our stored seeds. */
export function oraoRequestAddress(
  networkState: PublicKey,
  seed: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("orao-vrf-randomness-request"),
      networkState.toBuffer(),
      Buffer.from(seed),
    ],
    ORAO_VRF_PROGRAM_ID,
  )[0];
}

/** --seed hex, or 32 fresh random bytes when omitted. */
function clientSeed(raw: string | undefined): number[] {
  const bytes = raw ? parseHash(raw, "--seed") : randomBytes(32);
  if (bytes.length !== 32) throw new Error("--seed must be exactly 32 bytes");
  return Array.from(bytes);
}

const ROUND_STATUS = ["OPEN", "RANDOMNESS_REQUESTED", "SETTLED"];
const REQUEST_KIND = ["ROUND", "PRIZE", "JACKPOT"];
const REQUEST_STATUS = ["PENDING", "FULFILLED"];

export async function deposit(ctx: Context, poolId: bigint, amount: string) {
  const pool = await fetchPool(ctx, poolId);
  const value = parseAmount(amount, "--amount");
  const owner = ctx.wallet.publicKey;
  const signature = await send(ctx, [
    await method(ctx, "deposit", [toBn(value)])
      .accounts({
        owner,
        config: pda.config(),
        pool: pool.address,
        epoch: pda.epoch(pool.address, pool.latestEpochId),
        player: pda.player(pool.address, owner),
        acceptedMint: pool.acceptedMint,
        ownerAccepted: ata(pool.acceptedMint, owner, pool.acceptedTokenProgram),
        principalVault: pool.principalVault,
        principalMint: pool.principalMint,
        entryMint: pool.entryMint,
        ownerPrincipal: ata(pool.principalMint, owner, TOKEN_2022),
        ownerEntry: ata(pool.entryMint, owner, TOKEN_2022),
        acceptedTokenProgram: pool.acceptedTokenProgram,
        receiptTokenProgram: TOKEN_2022,
        associatedTokenProgram: ASSOCIATED_TOKEN,
        systemProgram: SYSTEM_PROGRAM,
      })
      .instruction(),
  ]);
  return {
    signature,
    pool: pool.address.toBase58(),
    owner: owner.toBase58(),
    amount: value.toString(),
  };
}

export async function withdraw(ctx: Context, poolId: bigint, amount: string) {
  const pool = await fetchPool(ctx, poolId);
  const value = parseAmount(amount, "--amount");
  const owner = ctx.wallet.publicKey;
  await ensureAta(ctx, pool.acceptedMint, owner, pool.acceptedTokenProgram);
  await ensureAta(ctx, pool.principalMint, owner, TOKEN_2022);
  await ensureAta(ctx, pool.entryMint, owner, TOKEN_2022);
  const signature = await send(ctx, [
    await method(ctx, "withdraw", [toBn(value)])
      .accounts({
        owner,
        config: pda.config(),
        pool: pool.address,
        acceptedMint: pool.acceptedMint,
        ownerAccepted: ata(pool.acceptedMint, owner, pool.acceptedTokenProgram),
        principalVault: pool.principalVault,
        principalMint: pool.principalMint,
        entryMint: pool.entryMint,
        ownerPrincipal: ata(pool.principalMint, owner, TOKEN_2022),
        ownerEntry: ata(pool.entryMint, owner, TOKEN_2022),
        acceptedTokenProgram: pool.acceptedTokenProgram,
        receiptTokenProgram: TOKEN_2022,
      })
      .instruction(),
  ]);
  return {
    signature,
    pool: pool.address.toBase58(),
    owner: owner.toBase58(),
    amount: value.toString(),
  };
}

export async function refresh(ctx: Context, poolId: bigint) {
  const pool = await fetchPool(ctx, poolId);
  const owner = ctx.wallet.publicKey;
  const signature = await send(ctx, [
    await method(ctx, "refreshEntries", [])
      .accounts({
        owner,
        config: pda.config(),
        pool: pool.address,
        epoch: pda.epoch(pool.address, pool.latestEpochId),
        player: pda.player(pool.address, owner),
        principalMint: pool.principalMint,
        entryMint: pool.entryMint,
        ownerPrincipal: ata(pool.principalMint, owner, TOKEN_2022),
        ownerEntry: ata(pool.entryMint, owner, TOKEN_2022),
        receiptTokenProgram: TOKEN_2022,
      })
      .instruction(),
  ]);
  return { signature, pool: pool.address.toBase58(), owner: owner.toBase58() };
}

export async function balances(
  ctx: Context,
  poolId: bigint,
  ownerArg?: string,
) {
  const pool = await fetchPool(ctx, poolId);
  const owner = ownerArg ? new PublicKey(ownerArg) : ctx.wallet.publicKey;
  const read = async (mint: PublicKey, program: PublicKey) => {
    const address = ata(mint, owner, program);
    const res = await ctx.connection
      .getTokenAccountBalance(address, "finalized")
      .catch(() => null);
    return {
      address: address.toBase58(),
      atomic: res ? res.value.amount : "0",
    };
  };
  const accepted = await read(pool.acceptedMint, pool.acceptedTokenProgram);
  const principal = await read(pool.principalMint, TOKEN_2022);
  const entry = await read(pool.entryMint, TOKEN_2022);
  const playerRecord = await fetchAccount(
    ctx,
    "player",
    pda.player(pool.address, owner),
  ).catch(() => null);
  const entryAmount = BigInt(entry.atomic);
  const principalAmount = BigInt(principal.atomic);
  return {
    pool: pool.address.toBase58(),
    owner: owner.toBase58(),
    decimals: pool.acceptedDecimals,
    accepted: {
      ...accepted,
      amount: fmtAmount(BigInt(accepted.atomic), pool.acceptedDecimals),
    },
    principal: {
      ...principal,
      amount: fmtAmount(principalAmount, pool.acceptedDecimals),
    },
    entries: {
      ...entry,
      amount: fmtAmount(entryAmount, pool.acceptedDecimals),
    },
    withdrawable: {
      atomic: (entryAmount < principalAmount
        ? entryAmount
        : principalAmount
      ).toString(),
    },
    lastEntryEpochId: playerRecord
      ? str((playerRecord as Record<string, unknown>).lastEntryEpochId)
      : null,
  };
}

export async function roundCreate(
  ctx: Context,
  poolId: bigint,
  opts: { roundId: string; starts: string; ends: string; bonus: string },
) {
  const pool = await fetchPool(ctx, poolId);
  const epochId = pool.latestEpochId;
  const round = pda.round(
    pool.address,
    epochId,
    parseAmount(opts.roundId, "--round-id"),
  );
  const signature = await send(ctx, [
    await method(ctx, "createRound", [
      toBn(parseAmount(opts.roundId, "--round-id")),
      toBn(parseTimeArg(opts.starts)),
      toBn(parseTimeArg(opts.ends)),
      toBn(parseAmount(opts.bonus, "--bonus")),
    ])
      .accounts({
        authority: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        epoch: pda.epoch(pool.address, epochId),
        round,
        systemProgram: SYSTEM_PROGRAM,
      })
      .instruction(),
  ]);
  return { signature, round: round.toBase58(), epochId: epochId.toString() };
}

function parseTimeArg(raw: string): bigint {
  return parseTime(raw, Math.floor(Date.now() / 1000));
}

export async function buyPosition(
  ctx: Context,
  poolId: bigint,
  opts: { roundId: string; tiles: string; stake: string },
) {
  const pool = await fetchPool(ctx, poolId);
  const epochId = pool.latestEpochId;
  const owner = ctx.wallet.publicKey;
  const roundId = parseAmount(opts.roundId, "--round-id");
  const round = pda.round(pool.address, epochId, roundId);
  const tiles = parseTilesArg(opts.tiles);
  const stake = parseAmount(opts.stake, "--stake");
  const signature = await send(ctx, [
    await method(ctx, "buyPosition", [toBn(tiles), toBn(stake)])
      .accounts({
        owner,
        config: pda.config(),
        pool: pool.address,
        epoch: pda.epoch(pool.address, epochId),
        player: pda.player(pool.address, owner),
        round,
        position: pda.position(pool.address, round, owner),
        entryMint: pool.entryMint,
        ownerEntry: ata(pool.entryMint, owner, TOKEN_2022),
        receiptTokenProgram: TOKEN_2022,
        systemProgram: SYSTEM_PROGRAM,
      })
      .instruction(),
  ]);
  return {
    signature,
    round: round.toBase58(),
    roundId: roundId.toString(),
    tiles: fmtTiles(tiles),
    tilesMask: tiles.toString(),
    stakePerTile: stake.toString(),
    totalStake: (stake * BigInt(fmtTileCount(tiles))).toString(),
  };
}

function fmtTileCount(mask: bigint): bigint {
  let count = 0n;
  for (let i = 0n; i < 36n; i += 1n) if ((mask & (1n << i)) !== 0n) count += 1n;
  return count;
}

function parseTilesArg(spec: string): bigint {
  return parseTiles(spec);
}

export async function roundShow(
  ctx: Context,
  poolId: bigint,
  roundId: bigint,
  epochId?: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const epoch = epochId ?? pool.latestEpochId;
  const address = pda.round(pool.address, epoch, roundId);
  const r = await fetchAccountStrict(
    ctx,
    "round",
    address,
    `round ${roundId} not found at ${address.toBase58()}`,
  );
  const status = Number(r.status);
  const stakes = (r.tileStakes as unknown as { toString(): string }[]) ?? [];
  return {
    address: address.toBase58(),
    pool: str(r.pool),
    epochId: str(r.epochId),
    roundId: str(r.id),
    status,
    statusName: ROUND_STATUS[status] ?? String(status),
    startsAt: str(r.startsAt),
    endsAt: str(r.endsAt),
    winningTile: Number(r.winningTile),
    bonusEntries: str(r.bonusEntries),
    totalStake: str(r.totalStake),
    tileStakes: stakes.map((s) => s.toString()),
    tilesStaked: stakes
      .map((s, i) => (BigInt(s.toString()) > 0n ? i : -1))
      .filter((i) => i >= 0),
  };
}

export async function claimRoundReward(
  ctx: Context,
  poolId: bigint,
  roundId: bigint,
  epochId?: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const epoch = epochId ?? pool.latestEpochId;
  const owner = ctx.wallet.publicKey;
  const round = pda.round(pool.address, epoch, roundId);
  const signature = await send(ctx, [
    await method(ctx, "claimRoundReward", [])
      .accounts({
        owner,
        config: pda.config(),
        pool: pool.address,
        round,
        position: pda.position(pool.address, round, owner),
        entryMint: pool.entryMint,
        ownerEntry: ata(pool.entryMint, owner, TOKEN_2022),
        receiptTokenProgram: TOKEN_2022,
      })
      .instruction(),
  ]);
  return {
    signature,
    round: round.toBase58(),
    roundId: roundId.toString(),
    owner: owner.toBase58(),
  };
}

export async function requestRandomness(
  ctx: Context,
  kind: "round" | "prize" | "jackpot",
  poolId: bigint,
  subjectId: bigint,
  epochId?: bigint,
  seedHex?: string,
) {
  const pool = await fetchPool(ctx, poolId);
  const kindIndex = kind === "round" ? 0 : kind === "prize" ? 1 : 2;
  // The round PDA binds to the round's OWN epoch: a delayed draw in a prior
  // epoch after rollover must pass --epoch-id explicitly.
  const roundEpoch = epochId ?? pool.latestEpochId;
  const subject =
    kind === "round"
      ? pda.round(pool.address, roundEpoch, subjectId)
      : pda.epoch(pool.address, subjectId);
  const name =
    kind === "round"
      ? "requestRoundRandomness"
      : kind === "prize"
        ? "requestPrizeRandomness"
        : "requestJackpotRandomness";
  const request = pda.request(pool.address, subject, kindIndex);
  const signature = await send(ctx, [
    await method(ctx, name, [clientSeed(seedHex)])
      .accounts({
        requester: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        ...(kind === "round" ? { round: subject } : { epoch: subject }),
        request,
        recentSlothaves: SLOTHASHES_SYSVAR,
        systemProgram: SYSTEM_PROGRAM,
      })
      .instruction(),
  ]);
  return {
    signature,
    instruction: name,
    kind: REQUEST_KIND[kindIndex],
    subject: subject.toBase58(),
    request: request.toBase58(),
  };
}

/**
 * Permissionless settle from the ORAO VRF (pull model): reads the ORAO
 * request PDA bound to the stored seed and submits `fulfill_<kind>_with_vrf`.
 * `--vrf-state` overrides the network-state account (default: ORAO's
 * canonical devnet/mainnet PDA).
 */
export async function fulfillVrfRandomness(
  ctx: Context,
  kind: "round" | "prize" | "jackpot",
  poolId: bigint,
  subjectId: bigint,
  epochId?: bigint,
  vrfState?: string,
) {
  const pool = await fetchPool(ctx, poolId);
  const kindIndex = kind === "round" ? 0 : kind === "prize" ? 1 : 2;
  const roundEpoch = epochId ?? pool.latestEpochId;
  const subject =
    kind === "round"
      ? pda.round(pool.address, roundEpoch, subjectId)
      : pda.epoch(pool.address, subjectId);
  const request = pda.request(pool.address, subject, kindIndex);
  const stored = await fetchAccountStrict(
    ctx,
    "randomnessRequest",
    request,
    `randomness request not found at ${request.toBase58()}`,
  );
  const seed = Buffer.from(stored.seed as unknown as ArrayLike<number>);
  const networkState = vrfState
    ? parsePubkey(vrfState, "--vrf-state")
    : oraoNetworkStateAddress();
  const name =
    kind === "round"
      ? "fulfillRoundWithVrf"
      : kind === "prize"
        ? "fulfillPrizeWithVrf"
        : "fulfillJackpotWithVrf";
  const oraoRequest = oraoRequestAddress(networkState, seed);
  const signature = await send(ctx, [
    await method(ctx, name, [])
      .accounts({
        requester: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        ...(kind === "round" ? { round: subject } : { epoch: subject }),
        request,
        oraoNetworkState: networkState,
        oraoRequest,
      })
      .instruction(),
  ]);
  return {
    signature,
    instruction: name,
    kind: REQUEST_KIND[kindIndex],
    request: request.toBase58(),
    oraoNetworkState: networkState.toBase58(),
    oraoRequest: oraoRequest.toBase58(),
  };
}

export async function fulfillRandomness(
  ctx: Context,
  kind: "round" | "prize" | "jackpot",
  poolId: bigint,
  subjectId: bigint,
  sample: string,
  epochId?: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const kindIndex = kind === "round" ? 0 : kind === "prize" ? 1 : 2;
  const roundEpoch = epochId ?? pool.latestEpochId;
  const subject =
    kind === "round"
      ? pda.round(pool.address, roundEpoch, subjectId)
      : pda.epoch(pool.address, subjectId);
  const name =
    kind === "round"
      ? "fulfillRoundWithMock"
      : kind === "prize"
        ? "fulfillPrizeWithMock"
        : "fulfillJackpotWithMock";
  const request = pda.request(pool.address, subject, kindIndex);
  const signature = await send(ctx, [
    await method(ctx, name, [toBn(parseAmount(sample, "--sample"))])
      .accounts({
        mockRandomnessAuthority: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        ...(kind === "round" ? { round: subject } : { epoch: subject }),
        request,
      })
      .instruction(),
  ]);
  return {
    signature,
    instruction: name,
    kind: REQUEST_KIND[kindIndex],
    request: request.toBase58(),
    sample,
    status: REQUEST_STATUS[1],
  };
}
