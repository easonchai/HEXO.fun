import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  bn,
  fakeOraoAccount,
  findEvent,
  longTimeouts,
  longWindow,
  oraoRequestAddress,
  tilesOf,
  type Pool,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;
const MAX_STAKE = AMT * 3n;
const BONUS_CAP = AMT * 5n;
const U64_MAX = (1n << 64n) - 1n;

describe("round lifecycle: creation guards, position guards, settlement and rewards", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let latePool: Pool;
  let alice: Keypair;
  let bob: Keypair;
  let carol: Keypair;
  let late: Keypair;
  let now: number;
  let bonusEntries: bigint;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool({ maxStakePerTile: MAX_STAKE });
    latePool = await hv.createPool({
      roundCloseBufferSeconds: 5,
      maxStakePerTile: MAX_STAKE,
    });
    now = await hv.chainNow();

    const window = longWindow(1n, now);
    await pool.createFirstEpoch(window);
    await latePool.createFirstEpoch(window);

    alice = await hv.wallet(AMT * 10n);
    bob = await hv.wallet(AMT * 10n);
    carol = await hv.wallet(AMT);
    late = await hv.wallet(AMT * 2n);

    await pool.deposit(alice, AMT * 10n);
    await pool.deposit(bob, AMT * 10n);
    await pool.deposit(carol, AMT);
    await latePool.deposit(late, AMT);

    await latePool.createRound(1n, now - 1, now + 2, 0n);
    await pool.createRound(1n, now - 1, now + 300, 0n);
    bonusEntries = BONUS_CAP;
  });

  it("rejects rounds whose window escapes the epoch", async () => {
    await expect(pool.createRound(7n, now - 40, now + 100, 0n)).rejects.toThrow(
      "InvalidTimeWindow",
    );
    await expect(
      pool.createRound(7n, now, longWindow(1n, now).endsAt + 5, 0n),
    ).rejects.toThrow("InvalidTimeWindow");
    await expect(pool.createRound(7n, now + 50, now + 50, 0n)).rejects.toThrow(
      "InvalidTimeWindow",
    );
  });

  it("rejects bonus entries above the pool cap", async () => {
    await expect(
      pool.createRound(7n, now, now + 50, BONUS_CAP + 1n),
    ).rejects.toThrow("BonusEntriesExceedCap");
    await pool.createRound(7n, now, now + 200, BONUS_CAP);
  });

  it("rejects invalid tile masks and stake amounts", async () => {
    await expect(pool.buy(alice, 1n, 0n, AMT)).rejects.toThrow(
      "InvalidTileSelection",
    );
    await expect(pool.buy(alice, 1n, 1n << 36n, AMT)).rejects.toThrow(
      "InvalidTileSelection",
    );
    await expect(pool.buy(alice, 1n, tilesOf(3), 0n)).rejects.toThrow(
      "InvalidStakeAmount",
    );
    await expect(
      pool.buy(alice, 1n, tilesOf(3), MAX_STAKE + AMT),
    ).rejects.toThrow("InvalidStakeAmount");
  });

  it("allows only one position per wallet per round", async () => {
    await pool.buy(alice, 1n, tilesOf(0), AMT);
    await expect(pool.buy(alice, 1n, tilesOf(5), AMT)).rejects.toThrow();
    expect(await pool.entryBalance(alice.publicKey)).toBe(AMT * 9n);
  });

  it("rejects purchases before the round opens and after the close buffer", async () => {
    const startsAt = (await hv.chainNow()) + 60;
    await pool.createRound(2n, startsAt, startsAt + 60, 0n);
    await expect(pool.buy(alice, 2n, tilesOf(1), AMT)).rejects.toThrow(
      "RoundClosed",
    );

    // close buffer of 5s on a round that ends in 2s: already closed
    await expect(latePool.buy(late, 1n, tilesOf(1), AMT)).rejects.toThrow(
      "RoundClosed",
    );
  });

  it("rejects purchases larger than the wallet entry balance", async () => {
    await expect(pool.buy(carol, 1n, tilesOf(1, 2, 3, 4), AMT)).rejects.toThrow(
      "InsufficientEntries",
    );
    expect(await pool.entryBalance(carol.publicKey)).toBe(AMT);
  });

  it("settles a multi player round through the mock randomness authority", async () => {
    const roundId = 3n;
    const endsAt = (await hv.chainNow()) + 8;
    await pool.createRound(roundId, endsAt - 10, endsAt, bonusEntries);
    await pool.buy(alice, roundId, tilesOf(0, 1), AMT * 2n);
    await pool.buy(bob, roundId, tilesOf(1), AMT * 3n);
    await pool.buy(carol, roundId, tilesOf(7), AMT);

    await expect(pool.requestRoundRandomness(roundId)).rejects.toThrow(
      "RoundClosed",
    );
    await hv.waitUntil(endsAt + 1);

    // permissionless request
    const bystander = await hv.wallet();
    await pool.requestRoundRandomness(roundId, bystander);
    await expect(pool.requestRoundRandomness(roundId)).rejects.toThrow();

    // The stored seed is slot-hash mixed: it can never equal the client seed.
    const requested = await pool.requestAccount(0, pool.roundOf(roundId));
    expect(Array.from(requested.seed as number[])).not.toEqual(
      Array.from({ length: 32 }, (_, i) => i),
    );

    // Localnet is mock-only (vrf_randomness_state = zero): the VRF settle
    // refuses any non-ORAO-owned account at the constraint layer (the
    // handler's VrfRandomnessDisabled gate is the second layer behind it).
    await expect(
      pool.fulfillRoundWithVrf(
        roundId,
        bystander.publicKey,
        bystander.publicKey,
      ),
    ).rejects.toThrow("InvalidRandomnessAccount");

    // Even a network-state account ORAO genuinely owns is rejected unless it
    // is the exact account pinned on config: the address constraint on
    // `orao_network_state` fires before any request PDA is inspected.
    const substituteNetworkState = await fakeOraoAccount(hv);
    const derivedRequest = oraoRequestAddress(
      substituteNetworkState,
      requested.seed,
    );
    await expect(
      pool.fulfillRoundWithVrf(
        roundId,
        substituteNetworkState,
        derivedRequest,
      ),
    ).rejects.toThrow("InvalidRandomnessAccount");

    await expect(pool.fulfillRound(roundId, U64_MAX)).rejects.toThrow(
      "RandomnessRejection",
    );
    const events = await hv.events(await pool.fulfillRound(roundId, 1n));
    const settled = findEvent(events, "RoundSettled");
    expect(settled?.data).toMatchObject({
      pool: pool.address,
      round: pool.roundOf(roundId),
      winningTile: 1,
    });

    const round = await pool.roundAccount(roundId);
    expect(round.status).toBe(2);
    expect(round.winningTile).toBe(1);
    expect(round.totalStake.toNumber()).toBe(Number(AMT * 8n));
    expect(Number(round.tileStakes[1])).toBe(Number(AMT * 5n));
    expect(Number(round.tileStakes[0])).toBe(Number(AMT * 2n));

    await expect(pool.fulfillRound(roundId, 1n)).rejects.toThrow(
      "InvalidRoundState",
    );
    const request = await pool.requestAccount(0, pool.roundOf(roundId));
    expect(request.status).toBe(1);
    expect(request.kind).toBe(0);
  });

  it("pays proportional ET rewards to winners only, bounded by the bonus entries", async () => {
    const roundId = 3n;
    const principalBefore = await pool.vaultBalance(pool.principalVault);

    const aliceBefore = await pool.entryBalance(alice.publicKey);
    const bobBefore = await pool.entryBalance(bob.publicKey);
    const aliceEvents = await hv.events(
      await pool.claimRoundReward(alice, roundId),
    );
    const bobReward = await pool.claimRoundReward(bob, roundId);

    const aliceReward = findEvent(aliceEvents, "RoundRewardClaimed")?.data
      ?.reward;
    const bobEvents = await hv.events(bobReward);
    const bobPaid = findEvent(bobEvents, "RoundRewardClaimed")?.data?.reward;

    expect(aliceReward.toNumber()).toBe(Number(AMT * 2n));
    expect(bobPaid.toNumber()).toBe(Number(AMT * 3n));
    expect(aliceReward.add(bobPaid).lte(bn(bonusEntries))).toBe(true);
    expect((await pool.entryBalance(alice.publicKey)).toString()).toBe(
      (aliceBefore + AMT * 2n).toString(),
    );
    expect((await pool.entryBalance(bob.publicKey)).toString()).toBe(
      (bobBefore + AMT * 3n).toString(),
    );
    // rewards are entry tokens only: no custody asset moved
    expect(await pool.vaultBalance(pool.principalVault)).toBe(principalBefore);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(0n);

    await expect(pool.claimRoundReward(alice, roundId)).rejects.toThrow(
      "RoundRewardAlreadyClaimed",
    );
    await expect(pool.claimRoundReward(carol, roundId)).rejects.toThrow(
      "NonWinningPosition",
    );
  });
});
