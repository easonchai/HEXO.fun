// Round lifecycle: pre-credit weight-neutrality, pro-rata settlement,
// forfeit-to-House, void-and-carry, and the buy_position guard rails (spec
// §2.3 "Rounds", §2.4 invariant 5).
//
// Every test runs against a real localnet validator, so give it room: a
// round has to actually elapse in wall-clock time before it can be settled.
// Round/close-buffer/vrf-timeout params are kept small per test to bound how
// long that takes.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  fulfillRandomness,
  playerPda,
  positionPda,
  program,
  provider,
  randomnessFor,
  randomnessPda,
  roundPda,
  setupPool,
  sleep,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;

// Pinned in vrf.rs; not exported from hx.ts since only this file's real (not
// test-vrf) CPI-shaped accounts need it.
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

type Wallet = Awaited<ReturnType<PoolCtx["fundedWallet"]>>;

function depositAccounts(pool: PoolCtx, owner: Wallet) {
  return {
    owner: owner.keypair.publicKey,
    pool: pool.pool,
    player: playerPda(pool.pool, owner.keypair.publicKey),
    acceptedMint: pool.mint,
    ownerToken: owner.tokenAccount,
    principalVault: pool.principalVault,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

async function deposit(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial(depositAccounts(pool, owner))
    .signers([owner.keypair])
    .rpc();
}

async function setPause(pool: PoolCtx, paused: boolean) {
  return program.methods
    .setPause(paused)
    .accountsPartial({ authority: pool.authority.publicKey, pool: pool.pool })
    .signers([pool.authority])
    .rpc();
}

/**
 * The validator's own Clock sysvar time. `solana-test-validator` derives
 * `unix_timestamp` from slot count, not wall time, and slots can run well
 * behind real time under load -- so every "now" a test reasons about (round
 * bounds, how long to sleep) has to come from here, not `Date.now()`, or it
 * drifts out of sync with what `utils::now()` reads on-chain.
 */
async function chainNow(): Promise<number> {
  const slot = await provider.connection.getSlot("confirmed");
  const t = await provider.connection.getBlockTime(slot);
  if (t != null) return t;
  const prev = await provider.connection.getBlockTime(Math.max(0, slot - 1));
  if (prev != null) return prev;
  throw new Error("chainNow: validator has no block time yet");
}

/** Creates a round starting now (validator time). `currentEpoch` only
 * matters once an epoch is open (`pool.currentEpochId != 0`); before that
 * any pubkey is accepted. */
async function createRound(
  pool: PoolCtx,
  roundSeconds: number,
  currentEpoch: PublicKey = pool.pool,
) {
  const startsAt = await chainNow();
  const endsAt = startsAt + roundSeconds;
  const poolAccount = await program.account.pool.fetch(pool.pool);
  const roundId = BigInt(poolAccount.nextRoundId.toString());
  const round = roundPda(pool.pool, roundId);

  await program.methods
    .createRound(new BN(startsAt), new BN(endsAt))
    .accountsPartial({
      authority: pool.authority.publicKey,
      pool: pool.pool,
      currentEpoch,
      round,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.authority])
    .rpc();

  return { roundId, round, startsAt, endsAt };
}

async function buyPosition(
  pool: PoolCtx,
  owner: Wallet,
  round: PublicKey,
  tiles: bigint,
  stakePerTile: bigint,
) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round,
      position: positionPda(round, owner.keypair.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

async function requestRandomness(pool: PoolCtx, round: PublicKey, seed: Uint8Array) {
  return program.methods
    .requestRoundRandomness()
    .accountsPartial({
      payer: provider.wallet.publicKey,
      pool: pool.pool,
      round,
      randomness: randomnessPda(seed),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

async function settleRound(pool: PoolCtx, round: PublicKey, seed: Uint8Array) {
  return program.methods
    .settleRound()
    .accountsPartial({
      authority: pool.authority.publicKey,
      pool: pool.pool,
      round,
      randomness: randomnessPda(seed),
      house: pool.house,
    })
    .signers([pool.authority])
    .rpc();
}

async function settlePosition(pool: PoolCtx, round: PublicKey, owner: PublicKey) {
  return program.methods
    .settlePosition()
    .accountsPartial({
      pool: pool.pool,
      round,
      player: playerPda(pool.pool, owner),
      owner,
      position: positionPda(round, owner),
    })
    .rpc();
}

async function voidRound(pool: PoolCtx, round: PublicKey) {
  return program.methods
    .voidRound()
    .accountsPartial({ authority: pool.authority.publicKey, pool: pool.pool, round })
    .signers([pool.authority])
    .rpc();
}

/** Runs the round to its end, requests randomness, and settles it with
 * `winningTile` as the drawn tile. Returns the fetched, settled Round. */
async function playToSettlement(pool: PoolCtx, round: PublicKey, endsAt: number, winningTile: number) {
  await waitUntil(endsAt);
  const roundBefore = await program.account.round.fetch(round);
  const seed = Uint8Array.from(roundBefore.vrfSeed);
  await requestRandomness(pool, round, seed);
  await fulfillRandomness(seed, randomnessFor(winningTile));
  await settleRound(pool, round, seed);
  return program.account.round.fetch(round);
}

/** Sleeps until `tsSeconds` (unix seconds) has passed, plus a margin for
 * clock skew between this process and the validator. */
/** Polls the validator's own clock (see `chainNow`) until it has passed
 * `tsSeconds` by at least `marginSeconds`, sleeping between checks. */
async function waitUntil(tsSeconds: number, marginSeconds = 1): Promise<void> {
  for (;;) {
    const now = await chainNow();
    const remaining = tsSeconds + marginSeconds - now;
    if (remaining <= 0) return;
    await sleep(Math.max(300, remaining * 1000));
  }
}

async function expectClosed(pda: PublicKey) {
  await expect(program.account.position.fetch(pda)).rejects.toThrow();
}

describe("rounds", () => {
  it(
    "winner takes the whole pot, loser's entries are gone, total entries conserved",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n); // tile 0
      await buyPosition(pool, bob, round, 1n << 1n, 1_000_000n); // tile 1

      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const bobPositionPda = positionPda(round, bob.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(alicePositionPda))!.lamports;
      const bobRentBefore = (await provider.connection.getAccountInfo(bobPositionPda))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(alice.keypair.publicKey);
      const bobBalBefore = await provider.connection.getBalance(bob.keypair.publicKey);

      const settled = await playToSettlement(pool, round, endsAt, 0); // tile 0 wins
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("2000000");

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(playerPda(pool.pool, alice.keypair.publicKey));
      const bobAfter = await program.account.player.fetch(playerPda(pool.pool, bob.keypair.publicKey));
      // Alice staked 1M of her 5M, then wins the whole 2M pot: 5M - 1M + 2M.
      expect(aliceAfter.entries.toString()).toBe("6000000");
      // Bob staked 1M and lost it outright.
      expect(bobAfter.entries.toString()).toBe("4000000");
      expect(aliceAfter.entries.add(bobAfter.entries).toString()).toBe("10000000");

      await expectClosed(alicePositionPda);
      await expectClosed(bobPositionPda);
      expect(await provider.connection.getBalance(alice.keypair.publicKey)).toBe(aliceBalBefore + aliceRentBefore);
      expect(await provider.connection.getBalance(bob.keypair.publicKey)).toBe(bobBalBefore + bobRentBefore);
    },
    TIMEOUT,
  );

  it(
    "pays winners on the winning tile pro rata, with dust left unminted",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 1_000_000n);
      await deposit(pool, bob, 1_000_000n);
      await deposit(pool, carol, 1_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      // Small stakes chosen so the pro-rata split leaves a remainder:
      // pot = 12, tile 5's total = 8, so alice gets floor(12*3/8) = 4 and bob
      // gets floor(12*5/8) = 7 -- 11 total, 1 unit of dust stays unminted.
      await buyPosition(pool, alice, round, 1n << 5n, 3n);
      await buyPosition(pool, bob, round, 1n << 5n, 5n);
      await buyPosition(pool, carol, round, 1n << 6n, 4n);

      const settled = await playToSettlement(pool, round, endsAt, 5);
      expect(settled.status).toBe(2); // Settled
      expect(settled.pot.toString()).toBe("12");

      await settlePosition(pool, round, alice.keypair.publicKey);
      await settlePosition(pool, round, bob.keypair.publicKey);
      await settlePosition(pool, round, carol.keypair.publicKey);

      const aliceAfter = await program.account.player.fetch(playerPda(pool.pool, alice.keypair.publicKey));
      const bobAfter = await program.account.player.fetch(playerPda(pool.pool, bob.keypair.publicKey));
      const carolAfter = await program.account.player.fetch(playerPda(pool.pool, carol.keypair.publicKey));
      // Started at 1_000_000, staked 3/5/4, alice and bob win their share back.
      expect(aliceAfter.entries.toString()).toBe("1000001"); // 1_000_000 - 3 + 4
      expect(bobAfter.entries.toString()).toBe("1000002"); // 1_000_000 - 5 + 7
      expect(carolAfter.entries.toString()).toBe("999996"); // 1_000_000 - 4 + 0

      const totalRewards = 4n + 7n;
      expect(totalRewards <= 12n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "forfeits an uncovered tile's pot to the House",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 6);
      await buyPosition(pool, alice, round, 1n << 2n, 1_000_000n); // tile 2 only

      const houseBefore = await program.account.player.fetch(pool.house);
      const settled = await playToSettlement(pool, round, endsAt, 7); // nobody on tile 7
      expect(settled.status).toBe(3); // Forfeited
      expect(settled.winningTile).toBe(7);

      const houseAfter = await program.account.player.fetch(pool.house);
      expect(houseAfter.entries.sub(houseBefore.entries).toString()).toBe("1000000");

      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(alicePositionPda))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(alice.keypair.publicKey);
      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(playerPda(pool.pool, alice.keypair.publicKey));
      expect(aliceAfter.entries.toString()).toBe("4000000"); // stake gone, no reward
      await expectClosed(alicePositionPda);
      expect(await provider.connection.getBalance(alice.keypair.publicKey)).toBe(aliceBalBefore + aliceRentBefore);
    },
    TIMEOUT,
  );

  it(
    "guards buy_position: close buffer, duplicate position, empty mask, over-stake",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 3 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);
      const carol = await pool.fundedWallet(10_000_000n);
      const dave = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);
      await deposit(pool, carol, 1_000_000n);
      await deposit(pool, dave, 5_000_000n);

      const { round, startsAt } = await createRound(pool, 6);

      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);
      // Same owner, same round: the Position PDA already exists.
      await expect(buyPosition(pool, alice, round, 1n << 1n, 1_000_000n)).rejects.toThrow();
      // Empty tile mask.
      await expect(buyPosition(pool, bob, round, 0n, 1_000_000n)).rejects.toThrow();
      // Stake total exceeds the player's Entries (carol only has 1_000_000).
      await expect(buyPosition(pool, carol, round, 1n << 3n, 2_000_000n)).rejects.toThrow();

      // Past ends_at - close_buffer (6 - 3 = 3s in), still before the round
      // itself ends, so this is specifically the close-buffer rejection.
      await waitUntil(startsAt + 6 - 3);
      await expect(buyPosition(pool, dave, round, 1n << 4n, 1_000_000n)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "buying a position is weight-neutral: staking everything matches just holding",
    async () => {
      const pool = await setupPool({ roundSeconds: 20, closeBuffer: 2 });
      const staker = await pool.fundedWallet(10_000_000n);
      const holder = await pool.fundedWallet(10_000_000n);
      // Both deposits in one transaction so both players' `last_update` is
      // the exact same on-chain instant -- comparing across two separately
      // submitted transactions would add a real (if small) timing skew.
      const depositIxs = await Promise.all(
        [staker, holder].map((w) =>
          program.methods.deposit(new BN("5000000")).accountsPartial(depositAccounts(pool, w)).instruction(),
        ),
      );
      await provider.sendAndConfirm(new Transaction().add(...depositIxs), [staker.keypair, holder.keypair]);

      const holderAfterDeposit = await program.account.player.fetch(playerPda(pool.pool, holder.keypair.publicKey));
      const holderWeight = BigInt(holderAfterDeposit.weightAcc.toString());
      const holderEntries = BigInt(holderAfterDeposit.entries.toString());
      const holderLastUpdate = BigInt(holderAfterDeposit.lastUpdate.toString());

      const { round, endsAt } = await createRound(pool, 20);
      // Stakes everything immediately: from this point her weight_acc never
      // changes again (entries == 0), pre-credited as if she held to ends_at.
      await buyPosition(pool, staker, round, 1n << 0n, 5_000_000n);

      const stakerAfter = await program.account.player.fetch(playerPda(pool.pool, staker.keypair.publicKey));

      // The holder is never touched again, so her weight at ends_at is
      // exactly what a future `touch` would compute: what's already
      // accumulated, plus her (unchanged) entries times the time left. Since
      // both players had identical entries and last_update the moment
      // before the round opened, this is also what the staker's weight
      // should be once she buys, whenever in the round she actually does.
      const holderProjectedAtEnd = holderWeight + holderEntries * (BigInt(endsAt) - holderLastUpdate);

      expect(BigInt(stakerAfter.weightAcc.toString())).toBe(holderProjectedAtEnd);
    },
    TIMEOUT,
  );

  it(
    "voiding after the vrf timeout carries the pot into the next round",
    async () => {
      const pool = await setupPool({ roundSeconds: 4, closeBuffer: 1, vrfTimeout: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      await deposit(pool, alice, 5_000_000n);

      const { round, endsAt } = await createRound(pool, 4);
      await buyPosition(pool, alice, round, 1n << 0n, 1_000_000n);

      await waitUntil(endsAt);
      const roundBefore = await program.account.round.fetch(round);
      const seed = Uint8Array.from(roundBefore.vrfSeed);
      await requestRandomness(pool, round, seed);
      const requested = await program.account.round.fetch(round);

      await waitUntil(Number(requested.requestedAt.toString()) + 2); // past vrf_timeout
      await voidRound(pool, round);

      const voided = await program.account.round.fetch(round);
      expect(voided.status).toBe(4); // Voided
      const poolAfterVoid = await program.account.pool.fetch(pool.pool);
      expect(poolAfterVoid.carryPot.toString()).toBe("1000000");

      const { round: round2 } = await createRound(pool, 4);
      const round2Account = await program.account.round.fetch(round2);
      expect(round2Account.pot.toString()).toBe("1000000");
      const poolAfterRound2 = await program.account.pool.fetch(pool.pool);
      expect(poolAfterRound2.carryPot.toString()).toBe("0");

      // settle_position on a voided round: zero reward, account still closes
      // and refunds rent.
      const alicePositionPda = positionPda(round, alice.keypair.publicKey);
      const aliceRentBefore = (await provider.connection.getAccountInfo(alicePositionPda))!.lamports;
      const aliceBalBefore = await provider.connection.getBalance(alice.keypair.publicKey);
      await settlePosition(pool, round, alice.keypair.publicKey);
      const aliceAfter = await program.account.player.fetch(playerPda(pool.pool, alice.keypair.publicKey));
      expect(aliceAfter.entries.toString()).toBe("4000000"); // no reward credited
      await expectClosed(alicePositionPda);
      expect(await provider.connection.getBalance(alice.keypair.publicKey)).toBe(aliceBalBefore + aliceRentBefore);
    },
    TIMEOUT,
  );

  it(
    "create_round rejects a paused pool and a second open round",
    async () => {
      const pool = await setupPool({ roundSeconds: 6, closeBuffer: 2 });

      await setPause(pool, true);
      await expect(createRound(pool, 6)).rejects.toThrow();
      await setPause(pool, false);

      await createRound(pool, 6); // now open
      await expect(createRound(pool, 6)).rejects.toThrow(); // still open
    },
    TIMEOUT,
  );

  it(
    "create_round rejects a round that would end after the current epoch",
    async (ctx) => {
      const pool = await setupPool({ epochSeconds: 30, roundSeconds: 6 });

      try {
        await program.methods
          .beginEpoch()
          .accountsPartial({
            authority: pool.authority.publicKey,
            pool: pool.pool,
            currentEpoch: epochPda(pool.pool, 0n),
            newEpoch: epochPda(pool.pool, 1n),
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.authority])
          .rpc();
      } catch (err) {
        // `begin_epoch` (ticket 04) is being implemented concurrently and is
        // a `todo!()` stub as of this ticket; skip until it lands rather
        // than implementing it here.
        ctx.skip(`begin_epoch unusable (ticket 04 in progress): ${(err as Error).message}`);
        return;
      }

      const poolAccount = await program.account.pool.fetch(pool.pool);
      const epoch = await program.account.epoch.fetch(epochPda(pool.pool, 1n));
      // ends_at must still satisfy ends_at - starts_at == round_seconds (6),
      // so this fails specifically on the epoch bound, not round length.
      const endsAt = new BN(epoch.endsAt.toString()).addn(1);
      const startsAt = endsAt.subn(6);
      await expect(
        program.methods
          .createRound(startsAt, endsAt)
          .accountsPartial({
            authority: pool.authority.publicKey,
            pool: pool.pool,
            currentEpoch: epochPda(pool.pool, BigInt(poolAccount.currentEpochId.toString())),
            round: roundPda(pool.pool, BigInt(poolAccount.nextRoundId.toString())),
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.authority])
          .rpc(),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
