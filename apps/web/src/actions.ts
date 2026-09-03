/** User-signed writes. Each action sends and confirms one program transaction. */
import { PublicKey, SystemProgram } from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN,
  TOKEN_2022,
  acceptedAta,
  bn,
  configAddress,
  method,
  playerAddress,
  positionAddress,
  randomnessAddress,
  receiptAta,
  roundAddress,
  type HexVaultProgram,
} from "./chain.js";
import type { PoolLike } from "./read.js";

export type { PoolLike };

const CONFIG = configAddress();

export interface TxSigner {
  readonly publicKey: PublicKey;
}

export interface ProofNodeJson {
  siblingHash: string | number[] | Uint8Array;
  siblingSum: string | number | bigint;
  siblingIsLeft: boolean;
}

export async function deposit(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  return method(
    program,
    "deposit",
  )(bn(amount))
    .accounts({
      owner: o,
      config: CONFIG,
      pool: pool.address,
      epoch,
      player: playerAddress(pool.address, o),
      acceptedMint: pool.acceptedMint,
      ownerAccepted: acceptedAta(
        pool.acceptedMint,
        o,
        pool.acceptedTokenProgram,
      ),
      principalVault: pool.principalVault,
      principalMint: pool.principalMint,
      entryMint: pool.entryMint,
      ownerPrincipal: receiptAta(pool.principalMint, o),
      ownerEntry: receiptAta(pool.entryMint, o),
      acceptedTokenProgram: pool.acceptedTokenProgram,
      receiptTokenProgram: TOKEN_2022,
      associatedTokenProgram: ASSOCIATED_TOKEN,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function withdraw(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  amount: bigint,
): Promise<string> {
  const o = owner.publicKey;
  return method(
    program,
    "withdraw",
  )(bn(amount))
    .accounts({
      owner: o,
      config: CONFIG,
      pool: pool.address,
      acceptedMint: pool.acceptedMint,
      ownerAccepted: acceptedAta(
        pool.acceptedMint,
        o,
        pool.acceptedTokenProgram,
      ),
      principalVault: pool.principalVault,
      principalMint: pool.principalMint,
      entryMint: pool.entryMint,
      ownerPrincipal: receiptAta(pool.principalMint, o),
      ownerEntry: receiptAta(pool.entryMint, o),
      acceptedTokenProgram: pool.acceptedTokenProgram,
      receiptTokenProgram: TOKEN_2022,
    })
    .rpc();
}

/** While paused, deposits are blocked but refresh restores matched capacity. */
export async function refreshEntries(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
): Promise<string> {
  const o = owner.publicKey;
  return method(program, "refreshEntries")()
    .accounts({
      owner: o,
      config: CONFIG,
      pool: pool.address,
      epoch,
      player: playerAddress(pool.address, o),
      principalMint: pool.principalMint,
      entryMint: pool.entryMint,
      ownerPrincipal: receiptAta(pool.principalMint, o),
      ownerEntry: receiptAta(pool.entryMint, o),
      receiptTokenProgram: TOKEN_2022,
    })
    .rpc();
}

export async function buyPosition(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  epochId: bigint,
  roundId: bigint,
  tilesMask: bigint,
  stakePerTile: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, epochId, roundId);
  return method(program, "buyPosition")(bn(tilesMask), bn(stakePerTile))
    .accounts({
      owner: o,
      config: CONFIG,
      pool: pool.address,
      epoch,
      player: playerAddress(pool.address, o),
      round,
      position: positionAddress(pool.address, round, o),
      entryMint: pool.entryMint,
      ownerEntry: receiptAta(pool.entryMint, o),
      receiptTokenProgram: TOKEN_2022,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export async function claimRoundReward(
  program: HexVaultProgram,
  owner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  epochId: bigint,
  roundId: bigint,
): Promise<string> {
  const o = owner.publicKey;
  const round = roundAddress(pool.address, epochId, roundId);
  return method(program, "claimRoundReward")()
    .accounts({
      owner: o,
      config: CONFIG,
      pool: pool.address,
      round,
      position: positionAddress(pool.address, round, o),
      entryMint: pool.entryMint,
      ownerEntry: receiptAta(pool.entryMint, o),
      receiptTokenProgram: TOKEN_2022,
    })
    .rpc();
}

/**
 * 32 fresh bytes from the browser CSPRNG. The program mixes in the slot hash
 * of the request slot, so the final VRF seed is unknowable before the tx
 * lands — this value alone never decides anything.
 */
export function randomClientSeed(): number[] {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return Array.from(seed);
}

const SLOTHASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111",
);

/** Permissionless: anyone may request the round draw once the round has closed. */
export async function requestRoundRandomness(
  program: HexVaultProgram,
  requester: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  epochId: bigint,
  roundId: bigint,
): Promise<string> {
  const round = roundAddress(pool.address, epochId, roundId);
  return method(
    program,
    "requestRoundRandomness",
  )(randomClientSeed())
    .accounts({
      requester: requester.publicKey,
      config: CONFIG,
      pool: pool.address,
      round,
      request: randomnessAddress(pool.address, round, 0),
      recentSlothaves: SLOTHASHES_SYSVAR,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** kind 1 = prize draw, kind 2 = jackpot draw (separate randomness domain). */
export async function requestEpochDraw(
  program: HexVaultProgram,
  requester: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  kind: 1 | 2,
): Promise<string> {
  const instruction =
    kind === 1 ? "requestPrizeRandomness" : "requestJackpotRandomness";
  return method(
    program,
    instruction,
  )(randomClientSeed())
    .accounts({
      requester: requester.publicKey,
      config: CONFIG,
      pool: pool.address,
      epoch,
      request: randomnessAddress(pool.address, epoch, kind),
      recentSlothaves: SLOTHASHES_SYSVAR,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** weight + proof come from the operator's `snapshot export` file. */
export async function claimPrize(
  program: HexVaultProgram,
  winner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  weight: bigint,
  proof: ProofNodeJson[],
): Promise<string> {
  return method(program, "claimPrize")(bn(weight), proof.map(toProofNode))
    .accounts({
      winner: winner.publicKey,
      config: CONFIG,
      pool: pool.address,
      epoch,
      acceptedMint: pool.acceptedMint,
      winnerAccepted: acceptedAta(
        pool.acceptedMint,
        winner.publicKey,
        pool.acceptedTokenProgram,
      ),
      prizeVault: pool.prizeVault,
      acceptedTokenProgram: pool.acceptedTokenProgram,
    })
    .rpc();
}

export async function claimJackpot(
  program: HexVaultProgram,
  winner: TxSigner,
  pool: PoolLike,
  epoch: PublicKey,
  weight: bigint,
  proof: ProofNodeJson[],
): Promise<string> {
  return method(program, "claimJackpot")(bn(weight), proof.map(toProofNode))
    .accounts({
      winner: winner.publicKey,
      config: CONFIG,
      pool: pool.address,
      epoch,
      acceptedMint: pool.acceptedMint,
      winnerAccepted: acceptedAta(
        pool.acceptedMint,
        winner.publicKey,
        pool.acceptedTokenProgram,
      ),
      jackpotVault: pool.jackpotVault,
      acceptedTokenProgram: pool.acceptedTokenProgram,
    })
    .rpc();
}

function toProofNode(node: ProofNodeJson): {
  siblingHash: number[];
  siblingSum: unknown;
  siblingIsLeft: boolean;
} {
  const hash = node.siblingHash;
  const bytes =
    typeof hash === "string"
      ? Array.from(hexToBytes(hash))
      : Array.from(hash, (b) => Number(b));
  if (bytes.length !== 32) {
    throw new Error(`proof sibling hash must be 32 bytes, got ${bytes.length}`);
  }
  return {
    siblingHash: bytes,
    siblingSum: bn(BigInt(node.siblingSum)),
    siblingIsLeft: Boolean(node.siblingIsLeft),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex in proof: ${hex.slice(0, 18)}…`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
