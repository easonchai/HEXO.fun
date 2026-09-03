import fs from "node:fs";

import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";

import { SYSTEM_PROGRAM, fetchAccountStrict, method } from "./anchor.js";
import { ata, ensureAta, fetchPool, pda, send, toBn } from "./client.js";
import type { Context } from "./client.js";
import { assertion, chainError, usage } from "./errors.js";
import { fetchEpoch } from "./epoch-ops.js";
import { fmtAmount, parseAmount, parsePubkey } from "./parse.js";
import { str } from "./pool-ops.js";

interface ProofNodeJson {
  siblingHash: string;
  siblingSum: string;
  siblingIsLeft: boolean;
}

type PublicKeyLike = { toBase58(): string };
interface SnapshotJson {
  pool?: string;
  epochId?: string;
  root?: string;
  totalWeight?: string;
  players?: { owner: string; weight: string; proof: ProofNodeJson[] }[];
}

function readJson(path: string): unknown {
  if (!fs.existsSync(path)) throw usage(`file not found: ${path}`);
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

type PlayerRecord = { owner: string; weight: string; proof: ProofNodeJson[] };

/** Accepts a full snapshot file, a bare players[] array, or a single proof record. */
function loadProof(
  snapshotPath: string,
  winner: string,
): { weight: bigint; proof: ProofNodeJson[] } {
  const doc = readJson(snapshotPath) as
    | SnapshotJson
    | PlayerRecord[]
    | PlayerRecord;
  if (Array.isArray(doc)) return pickPlayer(doc, winner);
  if ("players" in doc && doc.players) return pickPlayer(doc.players, winner);
  if ("proof" in doc && doc.proof) {
    const single = doc as unknown as { weight: string; proof: ProofNodeJson[] };
    return { weight: BigInt(single.weight), proof: single.proof };
  }
  throw usage(`${snapshotPath} has no players[] or proof[]`);
}

function pickPlayer(players: PlayerRecord[], winner: string) {
  const match = players.find((p) => p.owner === winner);
  if (!match) {
    throw assertion(
      `snapshot has no entry for ${winner} (players: ${players.length})`,
    );
  }
  return { weight: BigInt(match.weight), proof: match.proof };
}

function proofArgs(proof: ProofNodeJson[]) {
  return proof.map((n) => ({
    siblingHash: Uint8Array.from(
      Buffer.from(n.siblingHash.replace(/^0x/, ""), "hex"),
    ),
    siblingSum: toBn(BigInt(n.siblingSum)),
    siblingIsLeft: n.siblingIsLeft,
  }));
}

export async function fundVault(
  ctx: Context,
  which: "prize" | "jackpot",
  poolId: bigint,
  amount: string,
) {
  const pool = await fetchPool(ctx, poolId);
  const value = parseAmount(amount, "--amount");
  const funder = ctx.wallet.publicKey;
  const funderAccepted = await ensureAta(
    ctx,
    pool.acceptedMint,
    funder,
    pool.acceptedTokenProgram,
  );
  const vault = which === "prize" ? pool.prizeVault : pool.jackpotVault;
  const name = which === "prize" ? "fundPrize" : "fundJackpot";
  const signature = await send(ctx, [
    await method(ctx, name, [toBn(value)])
      .accounts({
        funder,
        config: pda.config(),
        pool: pool.address,
        acceptedMint: pool.acceptedMint,
        funderAccepted,
        [which === "prize" ? "prizeVault" : "jackpotVault"]: vault,
        acceptedTokenProgram: pool.acceptedTokenProgram,
      })
      .instruction(),
  ]);
  return {
    signature,
    vault: which,
    vaultAddress: vault.toBase58(),
    amount: value.toString(),
  };
}

export async function commitPrize(
  ctx: Context,
  poolId: bigint,
  epochId: bigint,
  snapshotFile: string,
  prizeAmount: string,
) {
  const pool = await fetchPool(ctx, poolId);
  const snapshot = readJson(snapshotFile) as SnapshotJson;
  if (!snapshot.root || !snapshot.totalWeight) {
    throw usage(
      `${snapshotFile} is missing root/totalWeight (run snapshot export)`,
    );
  }
  if (snapshot.epochId && BigInt(snapshot.epochId) !== epochId) {
    throw assertion(
      `snapshot is for epoch ${snapshot.epochId}, not ${epochId}`,
    );
  }
  if (snapshot.pool && snapshot.pool !== pool.address.toBase58()) {
    throw assertion(
      `snapshot is for pool ${snapshot.pool}, not ${pool.address.toBase58()}`,
    );
  }
  const epoch = pda.epoch(pool.address, epochId);
  const root = Uint8Array.from(
    Buffer.from(snapshot.root.replace(/^0x/, ""), "hex"),
  );
  if (root.length !== 32) throw usage("snapshot root must be 32 bytes of hex");
  const signature = await send(ctx, [
    await method(ctx, "commitPrizeSnapshot", [
      root,
      toBn(BigInt(snapshot.totalWeight)),
      toBn(parseAmount(prizeAmount, "--prize-amount")),
    ])
      .accounts({
        snapshotAuthority: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        epoch,
        prizeVault: pool.prizeVault,
      })
      .instruction(),
  ]);
  return {
    signature,
    epoch: epoch.toBase58(),
    root: snapshot.root,
    totalEntryWeight: snapshot.totalWeight,
    prizeAmount: parseAmount(prizeAmount, "--prize-amount").toString(),
  };
}

export async function commitJackpot(
  ctx: Context,
  poolId: bigint,
  epochId: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const epoch = pda.epoch(pool.address, epochId);
  const signature = await send(ctx, [
    await method(ctx, "commitJackpot", [])
      .accounts({
        snapshotAuthority: ctx.wallet.publicKey,
        config: pda.config(),
        pool: pool.address,
        epoch,
        jackpotVault: pool.jackpotVault,
      })
      .instruction(),
  ]);
  const record = await fetchAccountStrict(
    ctx,
    "epoch",
    epoch,
    `epoch ${epochId} missing`,
  );
  return {
    signature,
    epoch: epoch.toBase58(),
    jackpotAmount: str(record.jackpotAmount),
  };
}

export async function claimVault(
  ctx: Context,
  which: "prize" | "jackpot",
  poolId: bigint,
  epochId: bigint,
  opts: {
    winner?: string | undefined;
    weight?: string | undefined;
    proofFile?: string | undefined;
  },
) {
  if (!opts.proofFile) throw usage("--proof-file is required");
  const pool = await fetchPool(ctx, poolId);
  const winner = parsePubkey(
    opts.winner ?? ctx.wallet.publicKey.toBase58(),
    "--winner",
  );
  const loaded = loadProof(opts.proofFile, winner.toBase58());
  if (opts.weight && BigInt(opts.weight) !== loaded.weight) {
    throw assertion(
      `--weight ${opts.weight} disagrees with snapshot weight ${loaded.weight}`,
    );
  }
  const weight = loaded.weight;
  await ensureAta(ctx, pool.acceptedMint, winner, pool.acceptedTokenProgram);
  const vault = which === "prize" ? pool.prizeVault : pool.jackpotVault;
  const name = which === "prize" ? "claimPrize" : "claimJackpot";
  const signature = await send(ctx, [
    await method(ctx, name, [toBn(weight), proofArgs(loaded.proof)])
      .accounts({
        config: pda.config(),
        pool: pool.address,
        epoch: pda.epoch(pool.address, epochId),
        winner,
        acceptedMint: pool.acceptedMint,
        winnerAccepted: ata(
          pool.acceptedMint,
          winner,
          pool.acceptedTokenProgram,
        ),
        [which === "prize" ? "prizeVault" : "jackpotVault"]: vault,
        acceptedTokenProgram: pool.acceptedTokenProgram,
      })
      .instruction(),
  ]);
  return {
    signature,
    vault: which,
    winner: winner.toBase58(),
    weight: weight.toString(),
    proofLength: loaded.proof.length,
  };
}

export async function expireVault(
  ctx: Context,
  which: "prize" | "jackpot",
  poolId: bigint,
  epochId: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const epoch = pda.epoch(pool.address, epochId);
  const name = which === "prize" ? "expireUnclaimedPrize" : "expireJackpot";
  const signature = await send(ctx, [
    await method(ctx, name, [])
      .accounts({ config: pda.config(), pool: pool.address, epoch })
      .instruction(),
  ]);
  return { signature, vault: which, epoch: epoch.toBase58() };
}

export async function jackpotStatus(
  ctx: Context,
  poolId: bigint,
  epochId?: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const id = epochId ?? pool.latestEpochId;
  const epoch = await fetchEpoch(ctx, pool, id);
  const balance = await ctx.connection.getTokenAccountBalance(
    pool.jackpotVault,
    "finalized",
  );
  const prizeBalance = await ctx.connection.getTokenAccountBalance(
    pool.prizeVault,
    "finalized",
  );
  return {
    pool: pool.address.toBase58(),
    epochId: id.toString(),
    jackpot: {
      status: epoch.jackpotStatusName,
      amount: epoch.jackpotAmount,
      target: epoch.jackpotTarget,
      vaultBalance: balance.value.amount,
    },
    prize: {
      status: epoch.statusName,
      amount: epoch.prizeAmount,
      target: epoch.prizeTarget,
      vaultBalance: prizeBalance.value.amount,
      totalEntryWeight: epoch.totalEntryWeight,
      root: epoch.prizeSnapshotRoot,
    },
    claimDeadline: epoch.claimDeadline,
  };
}

export interface Verdict {
  check: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/** On-chain only: PT supply vs principal vault, and prize/jackpot solvency. */
export async function reconcile(ctx: Context, poolId: bigint) {
  const pool = await fetchPool(ctx, poolId);
  const verdicts: Verdict[] = [];
  const supply = async (mint: PublicKey) => {
    const res = await ctx.connection.getTokenSupply(mint, "finalized");
    return BigInt(res.value.amount);
  };
  const balance = async (address: PublicKey) => {
    const res = await ctx.connection.getTokenAccountBalance(
      address,
      "finalized",
    );
    return BigInt(res.value.amount);
  };

  const ptSupply = await supply(pool.principalMint);
  const principalVault = await balance(pool.principalVault);
  verdicts.push({
    check: "principal_token_supply_equals_principal_vault",
    expected: ptSupply.toString(),
    actual: principalVault.toString(),
    ok: ptSupply === principalVault,
  });

  const decimals = pool.acceptedDecimals;
  const describe = (amount: bigint) =>
    `${amount} (${fmtAmount(amount, decimals)})`;

  const epochId = pool.latestEpochId;
  if (epochId > 0n) {
    const epoch = await fetchEpoch(ctx, pool, epochId);
    const prizeVault = await balance(pool.prizeVault);
    const committed = BigInt(epoch.prizeAmount);
    if (committed > 0n) {
      verdicts.push({
        check: `epoch_${epochId}_prize_vault_covers_commit`,
        expected: describe(committed),
        actual: describe(prizeVault),
        ok: prizeVault >= committed,
      });
    }
    const jackpotAmount = BigInt(epoch.jackpotAmount);
    if (jackpotAmount > 0n) {
      const jackpotVault = await balance(pool.jackpotVault);
      verdicts.push({
        check: `epoch_${epochId}_jackpot_vault_covers_commit`,
        expected: describe(jackpotAmount),
        actual: describe(jackpotVault),
        ok: jackpotVault >= jackpotAmount,
      });
    }
    if (committed > 0n && BigInt(epoch.totalEntryWeight) === 0n) {
      verdicts.push({
        check: `epoch_${epochId}_snapshot_has_weight`,
        expected: "> 0",
        actual: "0",
        ok: false,
      });
    }
    const entriesSupply = await supply(pool.entryMint);
    verdicts.push({
      check: "entry_token_supply_report",
      expected: "informational (equals unspent entries)",
      actual: `${entriesSupply} (${fmtAmount(entriesSupply, decimals)})`,
      ok: true,
    });
  } else {
    verdicts.push({
      check: "epoch_present",
      expected: "at least one epoch",
      actual: "none",
      ok: false,
    });
  }

  return {
    pool: pool.address.toBase58(),
    poolId: poolId.toString(),
    decimals,
    verdicts,
    failed: verdicts.filter((v) => !v.ok).length,
    tokenPrograms: { receipt: TOKEN_2022_PROGRAM_ID.toBase58() },
  };
}
