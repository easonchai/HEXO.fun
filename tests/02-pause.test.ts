import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  findEvent,
  longTimeouts,
  proofFor,
  shortWindow,
  tilesOf,
  type EpochWindow,
  type Pool,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;

describe("pause matrix: guardian authority, what stops, what deliberately keeps working", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let player: Keypair;
  let nonGuardian: Keypair;
  let snapshot: Awaited<ReturnType<Pool["snapshotFromBalances"]>>;
  let epoch2: EpochWindow;
  let now: number;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    player = await hv.wallet(AMT * 6n);
    nonGuardian = await hv.wallet();
    now = await hv.chainNow();

    // Epoch 1: one player deposits, spends ET on a round, then the prize cycle
    // is claimed so epoch 2 can open with a clean rollover.
    const epoch1 = shortWindow(1n, now);
    await pool.createFirstEpoch(epoch1);
    await pool.deposit(player, AMT * 3n);
    await pool.createRound(1n, epoch1.startsAt, now + 10, 0n);
    await pool.buy(player, 1n, tilesOf(0, 1), AMT);

    await pool.fundPrize(hv.payer, AMT * 2n);
    await hv.waitUntil(epoch1.prizeSnapshotAt + 1);
    snapshot = await pool.snapshotFromBalances([player.publicKey]);
    await pool.commitPrizeSnapshot(snapshot, AMT * 2n);
    await pool.requestPrizeRandomness();
    await pool.fulfillPrize(0n);
    await pool.claimPrize(
      player.publicKey,
      snapshot.leaves[0].weight,
      proofFor(snapshot, player.publicKey),
    );

    epoch2 = {
      id: 2n,
      startsAt: epoch1.endsAt + 2,
      entryCutoffAt: epoch1.endsAt + 12,
      endsAt: epoch1.endsAt + 17,
      prizeSnapshotAt: epoch1.endsAt + 17,
      claimDeadline: epoch1.endsAt + 32,
    };
    await pool.beginNextEpoch(1n, epoch2);
    await hv.waitUntil(epoch2.startsAt + 1);
    await pool.createRound(2n, epoch2.startsAt, epoch2.endsAt, 0n);
  });

  it("rejects pause from a wallet that is not the configured guardian", async () => {
    await expect(pool.setPause(nonGuardian, true)).rejects.toThrow(
      "UnauthorizedGuardian",
    );
    expect((await pool.poolAccount()).paused).toBe(false);
  });

  it("stops deposits, round creation and snapshot commits while paused", async () => {
    const events = await hv.events(await pool.setPause(hv.payer, true));
    expect(
      String(findEvent(events, "ProtocolPauseChanged")?.data?.paused),
    ).toBe("true");

    await expect(pool.deposit(player, AMT)).rejects.toThrow("ProtocolPaused");
    await expect(
      pool.createRound(3n, epoch2.startsAt, epoch2.endsAt, 0n),
    ).rejects.toThrow("ProtocolPaused");
    await expect(pool.commitPrizeSnapshot(snapshot, AMT)).rejects.toThrow(
      "ProtocolPaused",
    );
    await expect(pool.commitJackpot()).rejects.toThrow("ProtocolPaused");
  });

  it("stops position purchases while paused", async () => {
    await expect(pool.buy(player, 2n, tilesOf(4), AMT)).rejects.toThrow(
      "ProtocolPaused",
    );
  });

  it("still refreshes entries while paused, restoring matched withdrawal capacity", async () => {
    expect(await pool.entryBalance(player.publicKey)).toBe(AMT);
    await pool.refresh(player);
    expect(await pool.entryBalance(player.publicKey)).toBe(AMT * 3n);
    expect(
      (await pool.playerAccount(player.publicKey)).lastEntryEpochId.toNumber(),
    ).toBe(2);
    await expect(pool.refresh(player)).rejects.toThrow(
      "EntriesAlreadyRefreshed",
    );
  });

  it("still lets a depositor withdraw matched principal while paused", async () => {
    await pool.withdraw(player, AMT);

    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 2n);
    expect(await pool.principalBalance(player.publicKey)).toBe(AMT * 2n);
    expect(await pool.entryBalance(player.publicKey)).toBe(AMT * 2n);
  });

  it("resumes normal operation after unpausing", async () => {
    await pool.setPause(hv.payer, false);
    await pool.deposit(player, AMT);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 3n);
    expect(await pool.entryBalance(player.publicKey)).toBe(AMT * 3n);
    expect((await pool.poolAccount()).paused).toBe(false);
  });
});
