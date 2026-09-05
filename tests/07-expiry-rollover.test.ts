import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  findEvent,
  longTimeouts,
  ownerOfInterval,
  proofFor,
  type EpochWindow,
  type Pool,
  type Snapshot,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;
const PRIZE = AMT * 5n;
const JACKPOT = AMT * 7n;

describe("expiry and rollover: deadlines, prize expiry, jackpot rollover", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let snapshot: Snapshot;
  let epoch1: EpochWindow;
  let winner: { owner: PublicKey; weight: bigint; prefix: bigint };

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    const now = await hv.chainNow();

    epoch1 = {
      id: 1n,
      startsAt: now - 5,
      entryCutoffAt: now + 20,
      endsAt: now + 25,
      prizeSnapshotAt: now + 25,
      claimDeadline: now + 40,
    };
    await pool.createFirstEpoch(epoch1);
    await pool.fundPrize(hv.payer, PRIZE);
    await pool.fundJackpot(hv.payer, JACKPOT);

    const alice = await hv.wallet(AMT * 10n);
    const bob = await hv.wallet(AMT * 10n);
    await pool.deposit(alice, AMT * 6n);
    await pool.deposit(bob, AMT * 2n);

    await hv.waitUntil(epoch1.prizeSnapshotAt + 1);
    snapshot = await pool.snapshotFromBalances([
      alice.publicKey,
      bob.publicKey,
    ]);

    await pool.commitPrizeSnapshot(snapshot, PRIZE);
    await pool.commitJackpot();

    await pool.requestPrizeRandomness();
    await pool.fulfillPrize(0n);
    await pool.requestJackpotRandomness();
    await pool.fulfillJackpot(0n);

    winner = ownerOfInterval(snapshot, 0n);
  });

  it("rejects expiry before the claim deadline", async () => {
    await expect(pool.expirePrize()).rejects.toThrow("PrizeClaimStillOpen");
    await expect(pool.expireJackpot()).rejects.toThrow("PrizeClaimStillOpen");
  });

  it("rejects both claims once the deadline has passed", async () => {
    await hv.waitUntil(epoch1.claimDeadline + 1);

    await expect(
      pool.claimPrize(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("PrizeClaimStillOpen");
    await expect(
      pool.claimJackpot(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("PrizeClaimStillOpen");
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(PRIZE);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(JACKPOT);
  });

  it("expires the unclaimed prize without moving any custody asset", async () => {
    const events = await hv.events(await pool.expirePrize());
    expect(findEvent(events, "PrizeExpired")?.data?.epochId?.toNumber()).toBe(
      1,
    );

    expect((await pool.epochAccount()).status).toBe(5);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(PRIZE);
    await expect(pool.expirePrize()).rejects.toThrow("PrizeAlreadyResolved");
  });

  it("refuses rollover while the jackpot commitment is unresolved", async () => {
    await expect(
      pool.beginNextEpoch(1n, {
        id: 2n,
        startsAt: epoch1.endsAt + 2,
        entryCutoffAt: epoch1.endsAt + 12,
        endsAt: epoch1.endsAt + 17,
        prizeSnapshotAt: epoch1.endsAt + 17,
        claimDeadline: epoch1.endsAt + 32,
      }),
    ).rejects.toThrow("InvalidJackpotState");
  });

  it("expires the jackpot by leaving its balance in the vault", async () => {
    const events = await hv.events(await pool.expireJackpot());
    expect(findEvent(events, "JackpotExpired")?.data?.epochId?.toNumber()).toBe(
      1,
    );

    expect((await pool.epochAccount()).jackpotStatus).toBe(4);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(JACKPOT);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(PRIZE);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 8n);
    await expect(pool.expireJackpot()).rejects.toThrow("InvalidJackpotState");
  });

  it("rolls over into the next epoch with the unclaimed jackpot still escrowed", async () => {
    await pool.beginNextEpoch(1n, {
      id: 2n,
      startsAt: epoch1.endsAt + 2,
      entryCutoffAt: epoch1.endsAt + 12,
      endsAt: epoch1.endsAt + 17,
      prizeSnapshotAt: epoch1.endsAt + 17,
      claimDeadline: epoch1.endsAt + 32,
    });

    expect((await pool.poolAccount()).latestEpochId.toNumber()).toBe(2);
    const next = await pool.epochAccount(2n);
    expect(next.status).toBe(0);
    expect(next.jackpotStatus).toBe(0);
    expect(next.prizeAmount.toNumber()).toBe(0);

    // the expired epoch's jackpot is untouched and still spendable by a future commit
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(JACKPOT);
  });
});

describe("expiry from snapshot-committed: randomness never requested still expires and unblocks rollover", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let epoch1: EpochWindow;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    const now = await hv.chainNow();

    epoch1 = {
      id: 1n,
      startsAt: now - 5,
      entryCutoffAt: now + 20,
      endsAt: now + 25,
      prizeSnapshotAt: now + 25,
      claimDeadline: now + 40,
    };
    await pool.createFirstEpoch(epoch1);
    await pool.fundPrize(hv.payer, PRIZE);

    const alice = await hv.wallet(AMT * 10n);
    await pool.deposit(alice, AMT * 5n);

    await hv.waitUntil(epoch1.prizeSnapshotAt + 1);
    const snapshot = await pool.snapshotFromBalances([alice.publicKey]);
    // snapshot committed, randomness never requested: status stays SNAPSHOT_COMMITTED
    await pool.commitPrizeSnapshot(snapshot, PRIZE);
  });

  it("rejects expiry before the claim deadline from snapshot-committed", async () => {
    expect((await pool.epochAccount()).status).toBe(1);
    await expect(pool.expirePrize()).rejects.toThrow("PrizeClaimStillOpen");
  });

  it("expires the never-requested epoch once the deadline passes, unblocking rollover", async () => {
    await hv.waitUntil(epoch1.claimDeadline + 1);

    const events = await hv.events(await pool.expirePrize());
    expect(findEvent(events, "PrizeExpired")?.data?.epochId?.toNumber()).toBe(
      1,
    );
    expect((await pool.epochAccount()).status).toBe(5);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(PRIZE);
    await expect(pool.expirePrize()).rejects.toThrow("PrizeAlreadyResolved");

    await pool.beginNextEpoch(1n, {
      id: 2n,
      startsAt: epoch1.endsAt + 2,
      entryCutoffAt: epoch1.endsAt + 12,
      endsAt: epoch1.endsAt + 17,
      prizeSnapshotAt: epoch1.endsAt + 17,
      claimDeadline: epoch1.endsAt + 32,
    });
    expect((await pool.poolAccount()).latestEpochId.toNumber()).toBe(2);
  });
});
