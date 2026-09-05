import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  buildSnapshot,
  fakeOraoAccount,
  findEvent,
  longTimeouts,
  oraoRequestAddress,
  ownerOfInterval,
  proofFor,
  type EpochWindow,
  type Pool,
  type Snapshot,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;
const PRIZE = AMT * 3n;

describe("prize lifecycle: snapshot commit, draw, merkle claim, rollover", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let snapshot: Snapshot;
  let epoch1: EpochWindow;
  let now: number;
  let alice: Keypair;
  let bob: Keypair;
  let winner: { owner: PublicKey; weight: bigint; prefix: bigint };
  let loser: { owner: PublicKey; weight: bigint };
  let usdcAtStart: Map<string, bigint>;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    now = await hv.chainNow();

    epoch1 = {
      id: 1n,
      startsAt: now - 5,
      entryCutoffAt: now + 25,
      endsAt: now + 30,
      prizeSnapshotAt: now + 30,
      claimDeadline: now + 50,
    };
    await pool.createFirstEpoch(epoch1);
    await pool.fundPrize(hv.payer, PRIZE);

    alice = await hv.wallet(AMT * 10n);
    bob = await hv.wallet(AMT * 10n);
    await pool.deposit(alice, AMT * 4n);
    await pool.deposit(bob, AMT);

    snapshot = await pool.snapshotFromBalances([
      alice.publicKey,
      bob.publicKey,
    ]);
    expect(snapshot.total).toBe(AMT * 5n);

    usdcAtStart = new Map([
      [alice.publicKey.toBase58(), await pool.acceptedBalance(alice.publicKey)],
      [bob.publicKey.toBase58(), await pool.acceptedBalance(bob.publicKey)],
    ]);
  });

  it("rejects the snapshot commit before prizeSnapshotAt and jackpot commits while the epoch is open", async () => {
    await expect(pool.commitPrizeSnapshot(snapshot, PRIZE)).rejects.toThrow(
      "InvalidTimeWindow",
    );
    await expect(pool.commitJackpot()).rejects.toThrow("InvalidEpochState");
  });

  it("rejects prize amounts above the segregated vault balance, then commits once", async () => {
    await hv.waitUntil(epoch1.prizeSnapshotAt + 1);

    await expect(pool.commitPrizeSnapshot(snapshot, AMT * 10n)).rejects.toThrow(
      "PrizeUnderfunded",
    );
    const events = await hv.events(
      await pool.commitPrizeSnapshot(snapshot, PRIZE),
    );
    const committed = findEvent(events, "PrizeSnapshotCommitted")?.data;
    expect(committed?.pool?.toBase58()).toBe(pool.address.toBase58());
    expect(committed?.prizeAmount?.toNumber()).toBe(Number(PRIZE));
    expect(committed?.totalEntryWeight?.toNumber()).toBe(
      Number(snapshot.total),
    );
    expect(Array.from(committed?.root ?? [])).toEqual(snapshot.root);
    expect((await pool.epochAccount()).status).toBe(1);

    await expect(pool.commitPrizeSnapshot(snapshot, PRIZE)).rejects.toThrow(
      "EpochNotOpen",
    );
  });

  it("draws the prize target and rejects expiry and out-of-interval claims before the deadline", async () => {
    await pool.requestPrizeRandomness();
    await expect(pool.requestPrizeRandomness()).rejects.toThrow();

    // Localnet is mock-only (vrf_randomness_state = zero): the VRF settle
    // refuses any non-ORAO-owned account at the constraint layer.
    const bystander = await hv.wallet();
    await expect(
      pool.fulfillPrizeWithVrf(bystander.publicKey, bystander.publicKey),
    ).rejects.toThrow("InvalidRandomnessAccount");

    // Even a network-state account ORAO genuinely owns is rejected unless it
    // is the exact account pinned on config: the address constraint on
    // `orao_network_state` fires before any request PDA is inspected.
    const requested = await pool.requestAccount(1, pool.epoch());
    const substituteNetworkState = await fakeOraoAccount(hv);
    const derivedRequest = oraoRequestAddress(
      substituteNetworkState,
      requested.seed,
    );
    await expect(
      pool.fulfillPrizeWithVrf(substituteNetworkState, derivedRequest),
    ).rejects.toThrow("InvalidRandomnessAccount");

    await pool.fulfillPrize(0n);
    expect((await pool.epochAccount()).status).toBe(3);
    expect((await pool.requestAccount(1, pool.epoch())).status).toBe(1);

    await expect(pool.expirePrize()).rejects.toThrow("PrizeClaimStillOpen");

    winner = ownerOfInterval(snapshot, 0n);
    const other = snapshot.leaves.find(
      (leaf) => leaf.owner.toBase58() !== winner.owner.toBase58(),
    );
    if (!other) throw new Error("expected a two leaf snapshot");
    loser = { owner: other.owner, weight: other.weight };

    // proven interval of a non winner
    await expect(
      pool.claimPrize(
        loser.owner,
        loser.weight,
        proofFor(snapshot, loser.owner),
      ),
    ).rejects.toThrow("NonWinningPrizeProof");
    // tampered weight does not resolve to the committed root
    await expect(
      pool.claimPrize(
        winner.owner,
        winner.weight + 1n,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("InvalidMerkleProof");
    await expect(
      pool.claimPrize(winner.owner, 0n, proofFor(snapshot, winner.owner)),
    ).rejects.toThrow("InvalidMerkleProof");
    // a proof from a different tree cannot resolve to the committed root
    const forged = buildSnapshot([
      { owner: winner.owner, weight: winner.weight + 1n },
    ]);
    await expect(
      pool.claimPrize(
        winner.owner,
        forged.total,
        proofFor(forged, winner.owner),
      ),
    ).rejects.toThrow("InvalidMerkleProof");
  });

  it("pays the committed prize from the prize vault only, to the proven winner", async () => {
    const principalBefore = await pool.vaultBalance(pool.principalVault);
    const prizeBefore = await pool.vaultBalance(pool.prizeVault);
    const jackpotBefore = await pool.vaultBalance(pool.jackpotVault);
    const winnerUsdc = usdcAtStart.get(winner.owner.toBase58()) ?? 0n;

    const events = await hv.events(
      await pool.claimPrize(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    );
    const claimed = findEvent(events, "PrizeClaimed")?.data;
    expect(claimed?.winner?.toBase58()).toBe(winner.owner.toBase58());
    expect(claimed?.amount?.toNumber()).toBe(Number(PRIZE));

    expect(await pool.vaultBalance(pool.prizeVault)).toBe(prizeBefore - PRIZE);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(principalBefore);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(jackpotBefore);
    expect(await pool.acceptedBalance(winner.owner)).toBe(winnerUsdc + PRIZE);
    expect((await pool.epochAccount()).status).toBe(4);

    await expect(
      pool.claimPrize(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("PrizeAlreadyResolved");
  });

  it("opens the next epoch once the prize is resolved", async () => {
    const epoch2: EpochWindow = {
      id: 2n,
      startsAt: epoch1.endsAt + 2,
      entryCutoffAt: epoch1.endsAt + 12,
      endsAt: epoch1.endsAt + 17,
      prizeSnapshotAt: epoch1.endsAt + 17,
      claimDeadline: epoch1.endsAt + 32,
    };
    await pool.beginNextEpoch(1n, epoch2);

    expect((await pool.poolAccount()).latestEpochId.toNumber()).toBe(2);
    const created = await pool.epochAccount(2n);
    expect(created.status).toBe(0);
    expect(created.jackpotStatus).toBe(0);
  });
});
