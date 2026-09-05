import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
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
const PRIZE = AMT * 2n;
const JACKPOT = AMT * 7n;

describe("jackpot lifecycle: separate escrow, separate draw domain, single claim", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let snapshot: Snapshot;
  let winner: { owner: PublicKey; weight: bigint; prefix: bigint };
  let loser: { owner: PublicKey; weight: bigint };

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    const now = await hv.chainNow();

    const epoch1: EpochWindow = {
      id: 1n,
      startsAt: now - 5,
      entryCutoffAt: now + 20,
      endsAt: now + 25,
      prizeSnapshotAt: now + 25,
      claimDeadline: now + 45,
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
    winner = ownerOfInterval(snapshot, 0n);
    const other = snapshot.leaves.find(
      (leaf) => leaf.owner.toBase58() !== winner.owner.toBase58(),
    );
    if (!other) throw new Error("expected a two leaf snapshot");
    loser = { owner: other.owner, weight: other.weight };
  });

  it("commits the current jackpot vault balance exactly once", async () => {
    const events = await hv.events(await pool.commitJackpot());
    const committed = findEvent(events, "JackpotCommitted")?.data;
    expect(committed?.jackpotAmount?.toNumber()).toBe(Number(JACKPOT));

    const epoch = await pool.epochAccount();
    expect(epoch.jackpotStatus).toBe(1);
    expect(epoch.jackpotAmount.toNumber()).toBe(Number(JACKPOT));

    await expect(pool.commitJackpot()).rejects.toThrow(
      "JackpotAlreadyCommitted",
    );
  });

  it("resolves the prize first, leaving the jackpot commitment intact", async () => {
    await pool.requestPrizeRandomness();
    await pool.fulfillPrize(0n);
    await pool.claimPrize(
      winner.owner,
      winner.weight,
      proofFor(snapshot, winner.owner),
    );

    expect(await pool.vaultBalance(pool.prizeVault)).toBe(0n);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(JACKPOT);
    expect((await pool.epochAccount()).jackpotStatus).toBe(1);
  });

  it("draws the jackpot in its own randomness domain", async () => {
    await pool.requestJackpotRandomness();
    await expect(pool.requestJackpotRandomness()).rejects.toThrow();

    const request = await pool.requestAccount(2, pool.epoch());
    expect(request.kind).toBe(2);
    expect(request.status).toBe(0);
    // the prize request is a different account and is already fulfilled
    expect((await pool.requestAccount(1, pool.epoch())).kind).toBe(1);

    // Localnet is mock-only (vrf_randomness_state = zero): the VRF settle
    // refuses any non-ORAO-owned account at the constraint layer.
    const bystander = await hv.wallet();
    await expect(
      pool.fulfillJackpotWithVrf(bystander.publicKey, bystander.publicKey),
    ).rejects.toThrow("InvalidRandomnessAccount");

    // Even a network-state account ORAO genuinely owns is rejected unless it
    // is the exact account pinned on config: the address constraint on
    // `orao_network_state` fires before any request PDA is inspected.
    const substituteNetworkState = await fakeOraoAccount(hv);
    const derivedRequest = oraoRequestAddress(
      substituteNetworkState,
      request.seed,
    );
    await expect(
      pool.fulfillJackpotWithVrf(substituteNetworkState, derivedRequest),
    ).rejects.toThrow("InvalidRandomnessAccount");

    await pool.fulfillJackpot(0n);
    const epoch = await pool.epochAccount();
    expect(epoch.jackpotStatus).toBe(2);
    expect(epoch.jackpotTarget.toNumber()).toBe(0);
  });

  it("rejects jackpot claims that are not the drawn interval", async () => {
    // the shared interval assertion in utils.rs reports the prize variant even
    // on the jackpot path: NonWinningJackpotProof (6041) is currently unused
    await expect(
      pool.claimJackpot(
        loser.owner,
        loser.weight,
        proofFor(snapshot, loser.owner),
      ),
    ).rejects.toThrow("NonWinningPrizeProof");
    await expect(
      pool.claimJackpot(
        winner.owner,
        winner.weight + 1n,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("InvalidMerkleProof");
  });

  it("pays the committed jackpot from the jackpot vault only", async () => {
    const prizeBefore = await pool.vaultBalance(pool.prizeVault);
    const principalBefore = await pool.vaultBalance(pool.principalVault);
    const winnerUsdc = await pool.acceptedBalance(winner.owner);

    const events = await hv.events(
      await pool.claimJackpot(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    );
    const claimed = findEvent(events, "JackpotClaimed")?.data;
    expect(claimed?.winner?.toBase58()).toBe(winner.owner.toBase58());
    expect(claimed?.amount?.toNumber()).toBe(Number(JACKPOT));

    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(0n);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(prizeBefore);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(principalBefore);
    expect(await pool.acceptedBalance(winner.owner)).toBe(winnerUsdc + JACKPOT);
    expect((await pool.epochAccount()).jackpotStatus).toBe(3);

    await expect(
      pool.claimJackpot(
        winner.owner,
        winner.weight,
        proofFor(snapshot, winner.owner),
      ),
    ).rejects.toThrow("InvalidJackpotState");
  });
});
