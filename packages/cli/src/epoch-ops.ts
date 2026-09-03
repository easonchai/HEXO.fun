import { SYSTEM_PROGRAM, fetchAccountStrict, method } from "./anchor.js";
import { fetchPool, pda, send, toBn } from "./client.js";
import type { Context } from "./client.js";
import { chainError } from "./errors.js";
import { hex, parseAmount, parseTime } from "./parse.js";

import type { PublicKey } from "@solana/web3.js";
import { str } from "./pool-ops.js";

const EPOCH_STATUS = [
  "OPEN",
  "SNAPSHOT_COMMITTED",
  "RANDOMNESS_REQUESTED",
  "PRIZE_DRAWN",
  "PRIZE_CLAIMED",
  "PRIZE_EXPIRED",
];
const JACKPOT_STATUS = ["NONE", "COMMITTED", "DRAWN", "CLAIMED", "EXPIRED"];

const nowSec = () => Math.floor(Date.now() / 1000);

export interface EpochTimingArgs {
  id?: string | undefined;
  starts: string;
  cutoff: string;
  ends: string;
  snapshot: string;
  deadline: string;
}

export async function epochCreate(
  ctx: Context,
  opts: EpochTimingArgs,
  poolId: bigint,
) {
  const pool = await fetchPool(ctx, poolId);
  const base = nowSec();
  const id = opts.id ? parseAmount(opts.id, "--id") : pool.latestEpochId + 1n;
  const timing = {
    id: toBn(id),
    startsAt: toBn(parseTime(opts.starts, base)),
    entryCutoffAt: toBn(parseTime(opts.cutoff, base)),
    endsAt: toBn(parseTime(opts.ends, base)),
    prizeSnapshotAt: toBn(parseTime(opts.snapshot, base)),
    claimDeadline: toBn(parseTime(opts.deadline, base)),
  };
  const epoch = pda.epoch(pool.address, id);
  const accounts = {
    authority: ctx.wallet.publicKey,
    config: pda.config(),
    pool: pool.address,
    priorEpoch: pda.epoch(pool.address, pool.latestEpochId),
    epoch,
    systemProgram: SYSTEM_PROGRAM,
  };
  const name =
    pool.latestEpochId === 0n ? "createFirstEpoch" : "beginNextEpoch";
  const signature = await send(ctx, [
    await method(ctx, name, [timing]).accounts(accounts).instruction(),
  ]);
  return {
    signature,
    instruction: name,
    pool: pool.address.toBase58(),
    epoch: epoch.toBase58(),
    timing: {
      id: id.toString(),
      startsAt: timing.startsAt.toString(),
      entryCutoffAt: timing.entryCutoffAt.toString(),
      endsAt: timing.endsAt.toString(),
      prizeSnapshotAt: timing.prizeSnapshotAt.toString(),
      claimDeadline: timing.claimDeadline.toString(),
    },
  };
}

export async function epochShow(ctx: Context, poolId: bigint, epochId: bigint) {
  const pool = await fetchPool(ctx, poolId);
  return fetchEpoch(ctx, pool, epochId);
}

export async function fetchEpoch(ctx: Context, pool: PoolRef, epochId: bigint) {
  const address = pda.epoch(pool.address, epochId);
  const e = await fetchAccountStrict(
    ctx,
    "epoch",
    address,
    `epoch ${epochId} not found at ${address.toBase58()}`,
  );
  const status = Number(e.status);
  const jackpotStatus = Number(e.jackpotStatus);
  return {
    address: address.toBase58(),
    pool: str(e.pool),
    epochId: str(e.id),
    status,
    statusName: EPOCH_STATUS[status] ?? String(status),
    startsAt: str(e.startsAt),
    entryCutoffAt: str(e.entryCutoffAt),
    endsAt: str(e.endsAt),
    prizeSnapshotAt: str(e.prizeSnapshotAt),
    claimDeadline: str(e.claimDeadline),
    prizeSnapshotRoot: hex(e.prizeSnapshotRoot as Uint8Array),
    totalEntryWeight: str(e.totalEntryWeight),
    prizeAmount: str(e.prizeAmount),
    prizeTarget: str(e.prizeTarget),
    jackpotStatus,
    jackpotStatusName: JACKPOT_STATUS[jackpotStatus] ?? String(jackpotStatus),
    jackpotAmount: str(e.jackpotAmount),
    jackpotTarget: str(e.jackpotTarget),
  };
}

export interface PoolRef {
  address: PublicKey;
}
