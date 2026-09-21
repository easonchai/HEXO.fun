// Epoch lifecycle: contiguous epochs, the register() weight cases, draw,
// payout to a player and to the House, rollover, and the closing invariant
// sweep (spec §2.3 "Epochs", §2.4 invariants 1-2 and 7-8).
//
// Epochs here run a handful of seconds (via the `epochSeconds` override) so
// tests sleep through them instead of a day. Each test airdrops, mints, and
// confirms several transactions against a real localnet validator.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  findEvent,
  fulfillRandomness,
  onChainNowSeconds,
  playerPda,
  positionPda,
  program,
  randomnessFor,
  randomnessPda,
  retryUntilOk,
  roundPda,
  setupPool,
  sleep,
  sleepUntilOnChain,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 90_000;

// ORAO's VRF program id, pinned on the pool at create_pool and re-checked by
// `close_registration`/`request_round_randomness`. test-vrf's request path
// never actually invokes it, so it needs no deployment on localnet.
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

const epoch_status = {
  OPEN: 0,
  REGISTERING: 1,
  DRAWING: 2,
  DRAWN: 3,
  PAID: 4,
  ROLLED_OVER: 5,
};

const round_status = {
  OPEN: 0,
  REQUESTED: 1,
  SETTLED: 2,
  FORFEITED: 3,
  VOIDED: 4,
};

type Wallet = { keypair: Keypair; tokenAccount: PublicKey };

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

async function requestWithdraw(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .requestWithdraw(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
    })
    .signers([owner.keypair])
    .rpc();
}

async function processWithdraw(pool: PoolCtx, owner: Wallet) {
  return program.methods
    .processWithdraw()
    .accountsPartial({
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/** `currentEpochId` is `pool.currentEpochId` *before* this call. */
async function beginEpoch(pool: PoolCtx, currentEpochId: bigint) {
  return program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      newEpoch: epochPda(pool.pool, currentEpochId + 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function setParams(pool: PoolCtx, epochSeconds: number) {
  return program.methods
    .setParams({
      epochSeconds: new BN(epochSeconds),
      epochAnchor: null,
      roundSeconds: null,
      closeBuffer: null,
      vrfTimeout: null,
      minDeposit: null,
      houseCutBps: null,
      minJackpot: null,
      registrationWindow: null,
      payoutTimeout: null,
      baseRateBps: null,
    })
    .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
    .rpc();
}

async function fundYield(pool: PoolCtx, source: Wallet, amount: bigint) {
  return program.methods
    .fundYield(new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: source.keypair.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      source: source.tokenAccount,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([source.keypair])
    .rpc();
}

async function register(pool: PoolCtx, epochId: bigint, owner: PublicKey) {
  return program.methods
    .register()
    .accountsPartial({
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      player: playerPda(pool.pool, owner),
    })
    .rpc();
}

async function fundJackpot(pool: PoolCtx, source: Wallet, amount: bigint) {
  return program.methods
    .fundJackpot(new BN(amount.toString()))
    .accountsPartial({
      sourceAuthority: source.keypair.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      source: source.tokenAccount,
      jackpotVault: pool.jackpotVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([source.keypair])
    .rpc();
}

async function closeRegistration(pool: PoolCtx, epochId: bigint) {
  return program.methods
    .closeRegistration()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      jackpotVault: pool.jackpotVault,
      // Never dereferenced under test-vrf (request_randomness no-ops), so a
      // fresh throwaway address is fine; its correctness only matters for a
      // real ORAO deployment.
      randomness: Keypair.generate().publicKey,
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function draw(pool: PoolCtx, epochId: bigint, randomness: PublicKey) {
  return program.methods
    .draw()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      randomness,
    })
    .signers([pool.operator])
    .rpc();
}

/** Permissionless: no signer at all, so the test wallet (neither the pool's
 *  admin nor its operator) just pays the fee. The operator cannot veto a
 *  winner by sitting out `payout_timeout`. */
async function payout(pool: PoolCtx, epochId: bigint, winner: PublicKey, winnerToken: PublicKey) {
  return program.methods
    .payout()
    .accountsPartial({
      pool: pool.pool,
      acceptedMint: pool.mint,
      epoch: epochPda(pool.pool, epochId),
      winner: playerPda(pool.pool, winner),
      jackpotVault: pool.jackpotVault,
      winnerToken,
      treasury: pool.treasury,
      buybackReserve: pool.buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/** `seed` is the Epoch's own `vrfSeed`: the program checks the randomness
 *  account against it and refuses to roll over a fulfilled request. */
async function rolloverEpoch(pool: PoolCtx, epochId: bigint, seed: Uint8Array | number[]) {
  return program.methods
    .rolloverEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      epoch: epochPda(pool.pool, epochId),
      randomness: randomnessPda(Uint8Array.from(seed)),
    })
    .signers([pool.operator])
    .rpc();
}

// --- Round helpers (rounds.rs is ticket 03's file; these just drive its
// already-landed instructions as a black box to forfeit a pot to the House.)

async function createRound(pool: PoolCtx, currentEpochId: bigint, roundId: bigint, startsAt: number, endsAt: number) {
  return program.methods
    .createRound(new BN(startsAt), new BN(endsAt))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, currentEpochId),
      round: roundPda(pool.pool, roundId),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function buyPosition(pool: PoolCtx, owner: Wallet, roundId: bigint, tiles: bigint, stakePerTile: bigint) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round: roundPda(pool.pool, roundId),
      position: PublicKey.findProgramAddressSync(
        [Buffer.from("position"), roundPda(pool.pool, roundId).toBuffer(), owner.keypair.publicKey.toBuffer()],
        program.programId,
      )[0],
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

async function requestRoundRandomness(pool: PoolCtx, roundId: bigint, seed: Uint8Array | number[]) {
  return program.methods
    .requestRoundRandomness()
    .accountsPartial({
      payer: pool.operator.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness: randomnessPda(Uint8Array.from(seed)),
      vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
      vrfTreasury: DEVNET_VRF_TREASURY,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
}

async function settleRound(pool: PoolCtx, roundId: bigint, randomness: PublicKey) {
  return program.methods
    .settleRound()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness,
      house: pool.house,
    })
    .signers([pool.operator])
    .rpc();
}

async function settlePosition(pool: PoolCtx, roundId: bigint, owner: PublicKey) {
  return program.methods
    .settlePosition()
    .accountsPartial({
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      player: playerPda(pool.pool, owner),
      owner,
      position: positionPda(roundPda(pool.pool, roundId), owner),
    })
    .rpc();
}

/** `seed` is the Round's own `vrfSeed`: the program checks the randomness
 *  account against it and refuses to void a request that was fulfilled. */
async function voidRound(pool: PoolCtx, roundId: bigint, seed: Uint8Array | number[]) {
  return program.methods
    .voidRound()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      round: roundPda(pool.pool, roundId),
      randomness: randomnessPda(Uint8Array.from(seed)),
    })
    .signers([pool.operator])
    .rpc();
}

async function fetchPlayer(pool: PoolCtx, owner: PublicKey) {
  return program.account.player.fetch(playerPda(pool.pool, owner));
}

async function fetchEpoch(pool: PoolCtx, epochId: bigint) {
  return program.account.epoch.fetch(epochPda(pool.pool, epochId));
}

describe("epochs", () => {
  it(
    "B depositing at half the epoch registers roughly half A's weight",
    async () => {
      const pool = await setupPool({ epochSeconds: 12 });
      // Wallet setup (airdrop, mint, ATA) is real wall-clock work; done
      // before `beginEpoch` fixes the epoch's `starts_at`, so it can't eat
      // into the window the midpoint math below assumes.
      const a = await pool.fundedWallet(10_000_000n);
      const b = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      const epoch1Open = await fetchEpoch(pool, 1n);
      // Polls the validator's actual on-chain clock for the midpoint
      // instead of comparing an on-chain deadline to `Date.now()`: the two
      // clocks drift apart, so a wall-clock sleep landed both deposits in
      // the same early sliver of the epoch rather than either side of its
      // midpoint.
      const startsAtSec = Number(epoch1Open.startsAt.toString());
      const endsAtSec = Number(epoch1Open.endsAt.toString());
      const midpointSec = Math.floor((startsAtSec + endsAtSec) / 2);

      await deposit(pool, a, 5_000_000n);
      await sleepUntilOnChain(midpointSec);
      await deposit(pool, b, 5_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);
      await register(pool, 1n, b.keypair.publicKey);

      const epoch = await fetchEpoch(pool, 1n);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const playerB = await fetchPlayer(pool, b.keypair.publicKey);

      const weightA = BigInt(playerA.regEnd.toString()) - BigInt(playerA.regStart.toString());
      const weightB = BigInt(playerB.regEnd.toString()) - BigInt(playerB.regStart.toString());

      // Exact recomputation from what's actually on chain removes any
      // dependence on hitting the sleep timings precisely: case 1 of
      // register() (neither player has been touched since the epoch ended).
      const endsAt = BigInt(epoch.endsAt.toString());
      const expectedA =
        BigInt(playerA.weightAcc.toString()) +
        BigInt(playerA.entries.toString()) * (endsAt - BigInt(playerA.lastUpdate.toString()));
      const expectedB =
        BigInt(playerB.weightAcc.toString()) +
        BigInt(playerB.entries.toString()) * (endsAt - BigInt(playerB.lastUpdate.toString()));
      expect(weightA).toBe(expectedA);
      expect(weightB).toBe(expectedB);

      // And the human-readable check the ticket asks for: roughly 2:1,
      // within a second of clock tolerance either way.
      const ratio = Number(weightA) / Number(weightB);
      expect(ratio).toBeGreaterThan(1.5);
      expect(ratio).toBeLessThan(2.7);
    },
    TIMEOUT,
  );

  it(
    "a player idle through a whole epoch registers principal x epoch length",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering, epoch 2 open

      // Player does nothing at all during epoch 2.
      const epoch2 = await fetchEpoch(pool, 2n);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch2 -> Registering, epoch 3 open

      await register(pool, 2n, a.keypair.publicKey);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const weight = BigInt(playerA.regEnd.toString()) - BigInt(playerA.regStart.toString());

      const epochLen = BigInt(epoch2.endsAt.toString()) - BigInt(epoch2.startsAt.toString());
      expect(weight).toBe(4_000_000n * epochLen);
    },
    TIMEOUT,
  );

  it(
    "a player touched in N+1 before registering for N registers frozen_weight, unaffected by a later deposit",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering, epoch 2 open

      // Touch the player inside epoch 2, before ever registering for epoch 1.
      await deposit(pool, a, 1_000_000n);
      const frozenAfterFirstTouch = (await fetchPlayer(pool, a.keypair.publicKey)).frozenWeight;

      // A further deposit still inside epoch 2 must not move frozen_weight
      // again (only a *fresh* boundary crossing ever rewrites it).
      await deposit(pool, a, 1_000_000n);
      const playerAfterSecondDeposit = await fetchPlayer(pool, a.keypair.publicKey);
      expect(playerAfterSecondDeposit.frozenWeight.toString()).toBe(frozenAfterFirstTouch.toString());
      expect(playerAfterSecondDeposit.frozenEpoch.toString()).toBe("1");

      await register(pool, 1n, a.keypair.publicKey);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const weight = BigInt(playerA.regEnd.toString()) - BigInt(playerA.regStart.toString());
      expect(weight).toBe(BigInt(frozenAfterFirstTouch.toString()));
    },
    TIMEOUT,
  );

  it(
    "a player who requests their whole balance mid-epoch still registers the weight they earned",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 5_000_000n);
      await sleep(2_000);
      await requestWithdraw(pool, a, 5_000_000n);
      const weightAccAtWithdraw = (await fetchPlayer(pool, a.keypair.publicKey)).weightAcc;

      await retryUntilOk(() => beginEpoch(pool, 1n));

      await register(pool, 1n, a.keypair.publicKey);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const weight = BigInt(playerA.regEnd.toString()) - BigInt(playerA.regStart.toString());

      // Entries were 0 for the rest of the epoch, so no further weight
      // accrued past the withdrawal: registered weight == weight_acc at
      // that instant, exactly.
      expect(weight).toBe(BigInt(weightAccAtWithdraw.toString()));
      expect(weight > 0n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "registering for the current (open) epoch fails, and registering twice for the same epoch fails",
    async () => {
      const pool = await setupPool({ epochSeconds: 5 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 2_000_000n);

      // Epoch 1 is still Open, not Registering.
      await expect(register(pool, 1n, a.keypair.publicKey)).rejects.toThrow();

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering

      await register(pool, 1n, a.keypair.publicKey);
      await expect(register(pool, 1n, a.keypair.publicKey)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "close_registration with zero registered weight rolls over and leaves the jackpot in the vault",
    async () => {
      const pool = await setupPool({ epochSeconds: 4 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 5_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering, nobody registers

      await closeRegistration(pool, 1n);

      const epoch = await fetchEpoch(pool, 1n);
      expect(epoch.status).toBe(epoch_status.ROLLED_OVER);
      expect(epoch.jackpotAmount.toString()).toBe("5000000");

      const vault = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vault.value.amount).toBe("5000000");
    },
    TIMEOUT,
  );

  it(
    "close_registration rolls over when the jackpot vault is under min_jackpot, and draws once it is not",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, minJackpot: 2_000_000 });
      await beginEpoch(pool, 0n); // epoch 1 open

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_999_999n); // one unit short

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);
      const sig = await closeRegistration(pool, 1n);

      const epoch1 = await fetchEpoch(pool, 1n);
      expect(epoch1.status).toBe(epoch_status.ROLLED_OVER);
      expect(epoch1.jackpotAmount.toString()).toBe("1999999");
      const event = await findEvent<{ epochId: BN; jackpotAmount: BN }>(sig, "epochRolledOver");
      expect(event?.epochId.toString()).toBe("1");
      // Registered weight was not the reason: the epoch had a registrant.
      expect(BigInt(epoch1.registeredWeight.toString()) > 0n).toBe(true);

      // The prize stayed put, so one more unit clears the floor next epoch.
      await fundJackpot(pool, funder, 1n);
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await register(pool, 2n, a.keypair.publicKey);
      await closeRegistration(pool, 2n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.status).toBe(epoch_status.DRAWING);
      expect(epoch2.jackpotAmount.toString()).toBe("2000000");
    },
    TIMEOUT,
  );

  it(
    "a player who lost every Entry can still request their whole Principal, and is paid after the boundary",
    async () => {
      const pool = await setupPool({ epochSeconds: 30, roundSeconds: 5, closeBuffer: 1 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      // Everything on tile 0, and tile 5 wins: the pot forfeits to the House
      // and Alice is left holding Entries 0 against Principal 5M.
      const startsAt = await onChainNowSeconds();
      await createRound(pool, 1n, 1n, startsAt, startsAt + 5);
      await buyPosition(pool, alice, 1n, 1n << 0n, 5_000_000n);
      const round1 = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await retryUntilOk(() => requestRoundRandomness(pool, 1n, round1.vrfSeed));
      await settleRound(
        pool,
        1n,
        await fulfillRandomness(Uint8Array.from(round1.vrfSeed), randomnessFor(5)),
      );
      expect((await program.account.round.fetch(roundPda(pool.pool, 1n))).status).toBe(
        round_status.FORFEITED,
      );
      expect((await fetchPlayer(pool, alice.keypair.publicKey)).entries.toString()).toBe("0");

      // The old `entries >= amount` rule would have locked her out here.
      await requestWithdraw(pool, alice, 5_000_000n);
      const requested = await fetchPlayer(pool, alice.keypair.publicKey);
      expect(requested.principal.toString()).toBe("0");
      expect(requested.pendingWithdraw.toString()).toBe("5000000");
      expect(requested.pendingEpoch.toString()).toBe("1");

      // Mid-epoch the pool's Entries now exceed its Principal: the House
      // still holds Alice's 5M while total_principal has dropped to 0.
      const midPool = await program.account.pool.fetch(pool.pool);
      const midHouse = await fetchPlayer(pool, pool.operator.publicKey);
      expect(midPool.totalPrincipal.toString()).toBe("0");
      expect(midPool.pendingWithdrawals.toString()).toBe("5000000");
      expect(BigInt(midHouse.entries.toString())).toBeGreaterThan(
        BigInt(midPool.totalPrincipal.toString()),
      );

      const before = await program.provider.connection.getTokenAccountBalance(alice.tokenAccount);
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await processWithdraw(pool, alice);
      const after = await program.provider.connection.getTokenAccountBalance(alice.tokenAccount);
      expect(BigInt(after.value.amount) - BigInt(before.value.amount)).toBe(5_000_000n);

      const paid = await fetchPlayer(pool, alice.keypair.publicKey);
      expect(paid.pendingWithdraw.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).pendingWithdrawals.toString()).toBe("0");

      // Equality comes back at the epoch start, once each Player is touched.
      // An empty round always touches the House on settlement, which is what
      // resets the Entries it was holding for the epoch that ended.
      const round2Start = await onChainNowSeconds();
      await createRound(pool, 2n, 2n, round2Start, round2Start + 5);
      const round2 = await program.account.round.fetch(roundPda(pool.pool, 2n));
      await retryUntilOk(() => requestRoundRandomness(pool, 2n, round2.vrfSeed));
      await settleRound(
        pool,
        2n,
        await fulfillRandomness(Uint8Array.from(round2.vrfSeed), randomnessFor(5)),
      );

      const endPool = await program.account.pool.fetch(pool.pool);
      const endHouse = await fetchPlayer(pool, pool.operator.publicKey);
      const endAlice = await fetchPlayer(pool, alice.keypair.publicKey);
      const entriesSum = BigInt(endHouse.entries.toString()) + BigInt(endAlice.entries.toString());
      expect(entriesSum + BigInt(endPool.carryPot.toString())).toBe(
        BigInt(endPool.totalPrincipal.toString()),
      );
    },
    TIMEOUT,
  );

  it(
    "draw and payout to a player: winner's balance rises by jackpot_amount, principal vault untouched",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      await closeRegistration(pool, 1n);

      const epochAfterClose = await fetchEpoch(pool, 1n);
      expect(epochAfterClose.status).toBe(epoch_status.DRAWING);

      const randomness = await fulfillRandomness(Uint8Array.from(epochAfterClose.vrfSeed));
      await draw(pool, 1n, randomness);

      const drawn = await fetchEpoch(pool, 1n);
      expect(drawn.status).toBe(epoch_status.DRAWN);

      const balanceBefore = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      const principalBefore = await program.provider.connection.getTokenAccountBalance(pool.principalVault);

      await payout(pool, 1n, a.keypair.publicKey, a.tokenAccount);

      const balanceAfter = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      const principalAfter = await program.provider.connection.getTokenAccountBalance(pool.principalVault);

      expect(BigInt(balanceAfter.value.amount) - BigInt(balanceBefore.value.amount)).toBe(2_000_000n);
      expect(principalAfter.value.amount).toBe(principalBefore.value.amount);

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(a.keypair.publicKey.toString());
    },
    TIMEOUT,
  );

  it(
    "the House wins: buyback gets 50%, treasury 20%, the vault keeps 30%",
    async () => {
      const pool = await setupPool({ epochSeconds: 14, roundSeconds: 5, closeBuffer: 0 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 6_000_000n);

      const startsAt = Math.floor(Date.now() / 1000);
      const endsAt = startsAt + 5;
      await createRound(pool, 1n, 1n, startsAt, endsAt);

      // A stakes everything on tile 0 only, leaving every other tile
      // uncovered so the draw below is guaranteed to forfeit.
      await buyPosition(pool, a, 1n, 1n, 6_000_000n);

      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await retryUntilOk(() => requestRoundRandomness(pool, 1n, round.vrfSeed));
      // Tile 1 is not covered by A's position (only tile 0 is): forfeit.
      const roundRandomness = await fulfillRandomness(Uint8Array.from(round.vrfSeed), randomnessFor(1));
      await settleRound(pool, 1n, roundRandomness);

      const roundAfter = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(roundAfter.status).toBe(round_status.FORFEITED);

      // --- Closing invariant sweep (spec §2.4 #1-2), right after the
      // forfeit: A's stake left `entries`, and reappeared whole in the
      // House's, so both should still add up to total_principal exactly.
      // Nothing is pending here; a `request_withdraw` would let Entries
      // exceed Principal until the next boundary (ADR 0009).
      const poolAfterForfeit = await program.account.pool.fetch(pool.pool);
      const playerA = await fetchPlayer(pool, a.keypair.publicKey);
      const house = await fetchPlayer(pool, pool.operator.publicKey);
      const principalVaultBalance = await program.provider.connection.getTokenAccountBalance(pool.principalVault);

      expect(playerA.principal.toString()).toBe(poolAfterForfeit.totalPrincipal.toString());
      expect(principalVaultBalance.value.amount).toBe(poolAfterForfeit.totalPrincipal.toString());
      expect(house.isHouse).toBe(true);
      expect(house.entries.toString()).toBe("6000000");
      expect(playerA.entries.toString()).toBe("0");
      const entriesSum = BigInt(playerA.entries.toString()) + BigInt(house.entries.toString());
      expect(entriesSum + BigInt(poolAfterForfeit.carryPot.toString())).toBe(
        BigInt(poolAfterForfeit.totalPrincipal.toString()),
      );

      // --- Register only the House for this epoch (A is deliberately never
      // registered), fund + draw + pay out, and check the split.
      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, pool.operator.publicKey);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 1_000_000n);
      await closeRegistration(pool, 1n);

      const closed = await fetchEpoch(pool, 1n);
      expect(closed.status).toBe(epoch_status.DRAWING);

      const randomness = await fulfillRandomness(Uint8Array.from(closed.vrfSeed));
      await draw(pool, 1n, randomness);

      const buybackBefore = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryBefore = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultBefore = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      // winner_token is unused by the handler for a House win (the split
      // goes to buyback_reserve/treasury instead), but the Accounts struct
      // still requires one satisfying `token::authority = winner.owner`, so
      // it must actually belong to the operator (the House's owner).
      const operatorToken = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );
      await payout(pool, 1n, pool.operator.publicKey, operatorToken.address);

      const buybackAfter = await program.provider.connection.getTokenAccountBalance(pool.buybackReserve);
      const treasuryAfter = await program.provider.connection.getTokenAccountBalance(pool.treasury);
      const vaultAfter = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);

      expect(BigInt(buybackAfter.value.amount) - BigInt(buybackBefore.value.amount)).toBe(500_000n); // 50%
      expect(BigInt(treasuryAfter.value.amount) - BigInt(treasuryBefore.value.amount)).toBe(200_000n); // 20%
      expect(BigInt(vaultBefore.value.amount) - BigInt(vaultAfter.value.amount)).toBe(700_000n); // 70% left
      expect(vaultAfter.value.amount).toBe("300000"); // 30% stays

      const paid = await fetchEpoch(pool, 1n);
      expect(paid.status).toBe(epoch_status.PAID);
      expect(paid.winner.toString()).toBe(pool.operator.publicKey.toString());
    },
    TIMEOUT,
  );

  it(
    "rollover_epoch after the timeout leaves the vault intact, and the next close_registration commits the larger amount",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);
      await closeRegistration(pool, 1n);

      const drawing = await fetchEpoch(pool, 1n);
      expect(drawing.status).toBe(epoch_status.DRAWING);

      // past vrf_timeout(2s), never fulfilled
      await retryUntilOk(() => rolloverEpoch(pool, 1n, drawing.vrfSeed));

      const rolled = await fetchEpoch(pool, 1n);
      expect(rolled.status).toBe(epoch_status.ROLLED_OVER);
      const vaultAfterRollover = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vaultAfterRollover.value.amount).toBe("3000000");

      // Fund more, let epoch 2 elapse too, and confirm the next
      // close_registration snapshots the grown total, not the stale 3M.
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 2n));
      await register(pool, 2n, a.keypair.publicKey);
      await closeRegistration(pool, 2n);

      const epoch2After = await fetchEpoch(pool, 2n);
      expect(epoch2After.jackpotAmount.toString()).toBe("5000000");
    },
    TIMEOUT,
  );

  it(
    "an unpaid drawn epoch keeps its prize: the next close only snapshots the new deposits",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      // Both deposit before the first epoch opens, so each one's register
      // takes the idle branch and cannot come out at zero weight.
      const a = await pool.fundedWallet(10_000_000n);
      const b = await pool.fundedWallet(10_000_000n);
      const funder = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);
      await deposit(pool, b, 3_000_000n);

      await beginEpoch(pool, 0n); // epoch 1
      await fundJackpot(pool, funder, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2
      await register(pool, 1n, a.keypair.publicKey);
      await closeRegistration(pool, 1n);
      const closed1 = await fetchEpoch(pool, 1n);
      expect(closed1.jackpotAmount.toString()).toBe("3000000");
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe(
        "3000000",
      );
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(closed1.vrfSeed)));

      // Epoch 1 is Drawn and unpaid. Its 3M is still in the vault, and the
      // next epoch must draw for its own 2M only.
      await fundJackpot(pool, funder, 2_000_000n);
      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3
      await register(pool, 2n, b.keypair.publicKey);
      await closeRegistration(pool, 2n);
      const closed2 = await fetchEpoch(pool, 2n);
      expect(closed2.jackpotAmount.toString()).toBe("2000000");
      await draw(pool, 2n, await fulfillRandomness(Uint8Array.from(closed2.vrfSeed)));

      const aBefore = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      await payout(pool, 1n, a.keypair.publicKey, a.tokenAccount);
      const aAfter = await program.provider.connection.getTokenAccountBalance(a.tokenAccount);
      expect(BigInt(aAfter.value.amount) - BigInt(aBefore.value.amount)).toBe(3_000_000n);

      const bBefore = await program.provider.connection.getTokenAccountBalance(b.tokenAccount);
      await payout(pool, 2n, b.keypair.publicKey, b.tokenAccount);
      const bAfter = await program.provider.connection.getTokenAccountBalance(b.tokenAccount);
      expect(BigInt(bAfter.value.amount) - BigInt(bBefore.value.amount)).toBe(2_000_000n);

      const drained = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(drained.value.amount).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "rollover_epoch is refused once the draw's randomness has been fulfilled",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, vrfTimeout: 2 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 3_000_000n);
      await closeRegistration(pool, 1n);

      const drawing = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(drawing.vrfSeed));
      // Past vrf_timeout, so the fulfilment is the only thing standing
      // between the operator and a rollover of a draw it has already read.
      await sleepUntilOnChain(Number(drawing.requestedAt.toString()) + 2 + 1);

      await expect(rolloverEpoch(pool, 1n, drawing.vrfSeed)).rejects.toThrow(
        /RandomnessAlreadyFulfilled/,
      );

      await draw(pool, 1n, randomness);
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWN);
    },
    TIMEOUT,
  );

  it(
    "close_registration waits out the registration window, and a late registrant still lands",
    async () => {
      const pool = await setupPool({ epochSeconds: 8, registrationWindow: 6 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      const epoch1 = await fetchEpoch(pool, 1n);
      // Registration opened when `begin_epoch` ran, not when the epoch ended.
      expect(Number(epoch1.registrationOpenedAt)).toBeGreaterThanOrEqual(
        Number(epoch1.endsAt),
      );

      // The epoch has ended and the operator would happily draw right now.
      await expect(closeRegistration(pool, 1n)).rejects.toThrow(
        /RegistrationWindowOpen/,
      );

      // Which is the point: this registration is still in time.
      await register(pool, 1n, a.keypair.publicKey);

      await sleepUntilOnChain(Number(epoch1.registrationOpenedAt.toString()) + 6);
      await retryUntilOk(() => closeRegistration(pool, 1n));

      const closed = await fetchEpoch(pool, 1n);
      expect(closed.status).toBe(epoch_status.DRAWING);
      expect(BigInt(closed.registeredWeight.toString()) > 0n).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a begin_epoch delayed past the window still owes the window from when it ran",
    async () => {
      // The attack this closes: hold begin_epoch back until `ends_at +
      // registration_window` has already gone by, then bundle begin_epoch,
      // one register of the operator's own player, and close_registration
      // into a single transaction and win alone.
      const pool = await setupPool({ epochSeconds: 6, registrationWindow: 5 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      const epoch1Open = await fetchEpoch(pool, 1n);
      // Late on purpose: past `ends_at + registration_window` already.
      await sleepUntilOnChain(Number(epoch1Open.endsAt.toString()) + 5 + 2);
      await beginEpoch(pool, 1n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const opened = Number(epoch1.registrationOpenedAt.toString());
      expect(opened).toBeGreaterThan(Number(epoch1.endsAt.toString()) + 5);

      // Same slot as the late begin_epoch: the window has not started yet.
      await expect(closeRegistration(pool, 1n)).rejects.toThrow(
        /RegistrationWindowOpen/,
      );
      await register(pool, 1n, a.keypair.publicKey);

      await sleepUntilOnChain(opened + 5);
      await retryUntilOk(() => closeRegistration(pool, 1n));
      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.DRAWING);
    },
    TIMEOUT,
  );

  it(
    "a drawn epoch nobody can be paid rolls over after payout_timeout, and its prize carries",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, payoutTimeout: 2 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 3_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);
      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 4_000_000n);
      await closeRegistration(pool, 1n);

      const closed = await fetchEpoch(pool, 1n);
      await draw(pool, 1n, await fulfillRandomness(Uint8Array.from(closed.vrfSeed)));
      const drawn = await fetchEpoch(pool, 1n);
      expect(Number(drawn.drawnAt.toString())).toBeGreaterThan(0);

      // The winner is known, so until the timeout the only way out is to pay.
      await expect(rolloverEpoch(pool, 1n, drawn.vrfSeed)).rejects.toThrow(
        /PayoutTimeoutNotElapsed/,
      );

      await sleepUntilOnChain(Number(drawn.drawnAt.toString()) + 2 + 1);
      await rolloverEpoch(pool, 1n, drawn.vrfSeed);

      const rolled = await fetchEpoch(pool, 1n);
      expect(rolled.status).toBe(epoch_status.ROLLED_OVER);
      expect(rolled.winner.toString()).toBe(PublicKey.default.toString());
      const vault = await program.provider.connection.getTokenAccountBalance(pool.jackpotVault);
      expect(vault.value.amount).toBe("4000000");
      // The reservation went with it, or the next close would snapshot 0.
      expect((await program.account.pool.fetch(pool.pool)).jackpotReserved.toString()).toBe("0");

      // Nothing was paid, so the next epoch draws for the same prize.
      await retryUntilOk(() => beginEpoch(pool, 2n));
      await register(pool, 2n, a.keypair.publicKey);
      await retryUntilOk(() => closeRegistration(pool, 2n));
      expect((await fetchEpoch(pool, 2n)).jackpotAmount.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "begin_epoch before the current epoch's ends_at fails",
    async () => {
      const pool = await setupPool();
      await beginEpoch(pool, 0n);
      await expect(beginEpoch(pool, 1n)).rejects.toThrow();
    },
    TIMEOUT,
  );

  // --- The anchored grid (epoch-anchor/02). Every boundary is a point of
  // `epochAnchor + k * epochSeconds`. These pools set the anchor a few
  // seconds ahead of `setupPool`, so epoch 1 is a short stub ending on the
  // first grid point and epoch 2 onwards run a full period. The clock cannot
  // be warped on localnet, so "minutes late" and "a whole period late" are
  // scaled down to seconds against a period of seconds; the arithmetic is
  // the same one an hourly pool goes through.

  const GRID_LEAD = 12;

  it(
    "an operator seconds late keeps the epochs contiguous",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 10, epochAnchor: anchor });

      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);
      // retryUntilOk polls every 750ms, so this lands within a second of the
      // boundary.
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.startsAt.toString()).toBe(epoch1.endsAt.toString());
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(10);
    },
    TIMEOUT,
  );

  it(
    "an operator well past the boundary but inside the period keeps the epochs contiguous",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 20, epochAnchor: anchor });

      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);
      await sleepUntilOnChain(Number(epoch1.endsAt) + 9);
      await beginEpoch(pool, 1n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(epoch2.startsAt.toString()).toBe(epoch1.endsAt.toString());
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(20);
    },
    TIMEOUT,
  );

  it(
    "an operator a whole period late jumps to the current grid point, and the epoch it left behind still pays out",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 8, epochAnchor: anchor });
      const a = await pool.fundedWallet(10_000_000n);

      // Deposited before the first epoch opens, so this player holds Entries
      // for every second of the stub whatever length it turns out to be.
      await deposit(pool, a, 4_000_000n);
      await beginEpoch(pool, 0n);
      const epoch1 = await fetchEpoch(pool, 1n);

      // Past the boundary *and* past the grid point after it.
      await sleepUntilOnChain(Number(epoch1.endsAt) + 8 + 1);
      await beginEpoch(pool, 1n);

      const epoch2 = await fetchEpoch(pool, 2n);
      expect(Number(epoch2.startsAt)).toBe(Number(epoch1.endsAt) + 8);
      expect((Number(epoch2.startsAt) - anchor) % 8).toBe(0);
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(8);

      // Epoch 1 was skipped past, not orphaned: it still runs its own draw.
      await register(pool, 1n, a.keypair.publicKey);
      await closeRegistration(pool, 1n);
      const closed = await fetchEpoch(pool, 1n);
      expect(closed.status).toBe(epoch_status.DRAWING);

      const randomness = await fulfillRandomness(Uint8Array.from(closed.vrfSeed));
      await draw(pool, 1n, randomness);
      await payout(pool, 1n, a.keypair.publicKey, a.tokenAccount);

      expect((await fetchEpoch(pool, 1n)).status).toBe(epoch_status.PAID);
    },
    TIMEOUT,
  );

  it(
    "the first epoch is a stub ending on the grid, and a deposit inside it freezes weight over the stub's own length",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 30, epochAnchor: anchor });
      const a = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, a, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const startsAt = BigInt(epoch1.startsAt.toString());
      const endsAt = BigInt(epoch1.endsAt.toString());
      expect(endsAt).toBe(BigInt(anchor)); // the first grid point after bootstrap
      expect(Number(endsAt - startsAt)).toBeGreaterThan(0);
      expect(Number(endsAt - startsAt)).toBeLessThan(30);

      const afterDeposit = await fetchPlayer(pool, a.keypair.publicKey);
      const lastUpdate = BigInt(afterDeposit.lastUpdate.toString());
      expect(Number(lastUpdate)).toBeLessThan(Number(endsAt));

      await retryUntilOk(() => beginEpoch(pool, 1n));
      // Any instruction that touches the player crosses the boundary and
      // freezes epoch 1's weight.
      await deposit(pool, a, 1_000_000n);

      const touched = await fetchPlayer(pool, a.keypair.publicKey);
      expect(touched.frozenEpoch.toString()).toBe("1");
      expect(BigInt(touched.frozenWeight.toString())).toBe(5_000_000n * (endsAt - lastUpdate));
      expect(Number(touched.frozenWeight)).toBeLessThan(5_000_000 * 30);
    },
    TIMEOUT,
  );

  it(
    "raising epoch_seconds mid-epoch gives one short transition epoch, then the new cadence, and leaves the old epoch's weight alone",
    async () => {
      const anchor = (await onChainNowSeconds()) + GRID_LEAD;
      const pool = await setupPool({ epochSeconds: 8, epochAnchor: anchor });
      const a = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n); // epoch 1: the stub
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch 2: a full 8s period
      const epoch2 = await fetchEpoch(pool, 2n);
      expect(Number(epoch2.endsAt) - Number(epoch2.startsAt)).toBe(8);

      await deposit(pool, a, 5_000_000n);
      const inEpoch2 = await fetchPlayer(pool, a.keypair.publicKey);
      const lastUpdate = BigInt(inEpoch2.lastUpdate.toString());

      await setParams(pool, 24); // the daily-to-weekly switch, scaled down

      await retryUntilOk(() => beginEpoch(pool, 2n)); // epoch 3: the transition
      const epoch3 = await fetchEpoch(pool, 3n);
      expect(epoch3.startsAt.toString()).toBe(epoch2.endsAt.toString());
      expect((Number(epoch3.endsAt) - anchor) % 24).toBe(0);
      expect(Number(epoch3.endsAt) - Number(epoch3.startsAt)).toBeLessThan(24);

      // Epoch 2 ended where its own Epoch account says it did, not 24s after
      // it started.
      await deposit(pool, a, 1_000_000n);
      const touched = await fetchPlayer(pool, a.keypair.publicKey);
      expect(touched.frozenEpoch.toString()).toBe("2");
      expect(BigInt(touched.frozenWeight.toString())).toBe(
        5_000_000n * (BigInt(epoch2.endsAt.toString()) - lastUpdate),
      );

      await retryUntilOk(() => beginEpoch(pool, 3n)); // epoch 4: the new cadence
      const epoch4 = await fetchEpoch(pool, 4n);
      expect(Number(epoch4.endsAt) - Number(epoch4.startsAt)).toBe(24);
    },
    TIMEOUT,
  );

  // --- Cross-epoch Round settlement (audit-fixes/01): the program's own
  // guard against crediting a Round into an Epoch it didn't run in. `touch`
  // has already reset Entries to Principal for anyone it sees by the time
  // these settle, so the pot has to evaporate instead of paying out, or the
  // invariant below would drift.

  it(
    "a Round settled after its Epoch rolls over pays nothing, but stays zero-sum",
    async () => {
      const pool = await setupPool({ epochSeconds: 24, roundSeconds: 8, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n); // epoch 1 open
      await deposit(pool, alice, 5_000_000n);
      await deposit(pool, bob, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 8; // the Round ends exactly at the Epoch's ends_at

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n); // tile 0
      await buyPosition(pool, bob, 1n, 1n << 1n, 1_000_000n); // tile 1

      await sleepUntilOnChain(endsAt);
      // Roll the Epoch before the Round is ever settled: the program's own
      // guard, not the operator's ordering, is what has to hold here.
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await retryUntilOk(() => requestRoundRandomness(pool, 1n, round.vrfSeed));
      const randomness = await fulfillRandomness(Uint8Array.from(round.vrfSeed), randomnessFor(0)); // tile 0 wins
      await settleRound(pool, 1n, randomness);

      const settled = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(settled.status).toBe(round_status.SETTLED);
      // The Round records the cut it would have taken, but the Epoch has
      // rolled over, so it evaporated with the rest of the pot instead of
      // reaching the House.
      expect(settled.houseCut.toString()).toBe("120000"); // 6% of 2M
      expect((await fetchPlayer(pool, pool.operator.publicKey)).entries.toString()).toBe("0");

      const alicePositionPda = positionPda(roundPda(pool.pool, 1n), alice.keypair.publicKey);
      const bobPositionPda = positionPda(roundPda(pool.pool, 1n), bob.keypair.publicKey);
      const aliceRentBefore = (await program.provider.connection.getAccountInfo(alicePositionPda))!.lamports;
      const bobRentBefore = (await program.provider.connection.getAccountInfo(bobPositionPda))!.lamports;
      const aliceBalBefore = await program.provider.connection.getBalance(alice.keypair.publicKey);
      const bobBalBefore = await program.provider.connection.getBalance(bob.keypair.publicKey);

      const aliceSig = await settlePosition(pool, 1n, alice.keypair.publicKey);
      const bobSig = await settlePosition(pool, 1n, bob.keypair.publicKey);

      const aliceEvent = await findEvent<{ reward: BN }>(aliceSig, "positionSettled");
      const bobEvent = await findEvent<{ reward: BN }>(bobSig, "positionSettled");
      expect(aliceEvent?.reward.toString()).toBe("0");
      expect(bobEvent?.reward.toString()).toBe("0");

      const playerA = await fetchPlayer(pool, alice.keypair.publicKey);
      const playerB = await fetchPlayer(pool, bob.keypair.publicKey);
      const house = await fetchPlayer(pool, pool.operator.publicKey);
      const poolAfter = await program.account.pool.fetch(pool.pool);

      const entriesSum =
        BigInt(playerA.entries.toString()) + BigInt(playerB.entries.toString()) + BigInt(house.entries.toString());
      expect(entriesSum).toBe(BigInt(poolAfter.totalPrincipal.toString()));

      await expect(program.account.position.fetch(alicePositionPda)).rejects.toThrow();
      await expect(program.account.position.fetch(bobPositionPda)).rejects.toThrow();
      expect(await program.provider.connection.getBalance(alice.keypair.publicKey)).toBe(
        aliceBalBefore + aliceRentBefore,
      );
      expect(await program.provider.connection.getBalance(bob.keypair.publicKey)).toBe(bobBalBefore + bobRentBefore);
    },
    TIMEOUT,
  );

  it(
    "a forfeited Round from an ended Epoch credits the House nothing",
    async () => {
      const pool = await setupPool({ epochSeconds: 24, roundSeconds: 8, closeBuffer: 2 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 8;

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n); // tile 0 only

      await sleepUntilOnChain(endsAt);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const houseBefore = await fetchPlayer(pool, pool.operator.publicKey);

      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await retryUntilOk(() => requestRoundRandomness(pool, 1n, round.vrfSeed));
      const randomness = await fulfillRandomness(Uint8Array.from(round.vrfSeed), randomnessFor(5)); // nobody on tile 5
      await settleRound(pool, 1n, randomness);

      const settled = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(settled.status).toBe(round_status.FORFEITED);

      const houseAfter = await fetchPlayer(pool, pool.operator.publicKey);
      expect(houseAfter.entries.toString()).toBe(houseBefore.entries.toString());
    },
    TIMEOUT,
  );

  it(
    "voiding a Round from an ended Epoch adds nothing to carry_pot",
    async () => {
      const pool = await setupPool({ epochSeconds: 20, roundSeconds: 6, closeBuffer: 1, vrfTimeout: 2 });
      const alice = await pool.fundedWallet(10_000_000n);

      await beginEpoch(pool, 0n);
      await deposit(pool, alice, 5_000_000n);

      const epoch1 = await fetchEpoch(pool, 1n);
      const endsAt = Number(epoch1.endsAt.toString());
      const startsAt = endsAt - 6;

      await sleepUntilOnChain(startsAt);
      await createRound(pool, 1n, 1n, startsAt, endsAt);
      await buyPosition(pool, alice, 1n, 1n << 0n, 1_000_000n);

      await sleepUntilOnChain(endsAt);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const round = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(round.pot.toString()).toBe("1000000");
      await retryUntilOk(() => requestRoundRandomness(pool, 1n, round.vrfSeed));

      const requested = await program.account.round.fetch(roundPda(pool.pool, 1n));
      await sleepUntilOnChain(Number(requested.requestedAt.toString()) + 2 + 1); // past vrf_timeout

      const poolBeforeVoid = await program.account.pool.fetch(pool.pool);
      expect(poolBeforeVoid.carryPot.toString()).toBe("0");
      const sig = await retryUntilOk(() => voidRound(pool, 1n, round.vrfSeed));

      const voided = await program.account.round.fetch(roundPda(pool.pool, 1n));
      expect(voided.status).toBe(round_status.VOIDED);

      const poolAfterVoid = await program.account.pool.fetch(pool.pool);
      expect(poolAfterVoid.carryPot.toString()).toBe("0"); // the 1M pot evaporated, not carried

      const event = await findEvent<{ carryPot: BN }>(sig, "roundVoided");
      expect(event?.carryPot.toString()).toBe("0");
    },
    TIMEOUT,
  );

  // --- Base yield (hexo-referrals ticket 01, ADR 0011). `register` credits
  // `min(principal_seconds * base_rate_bps / (10_000 * year), yield_budget)`
  // once per Player per ended epoch, guarded by `yield_epoch` independent of
  // `reg_epoch` (a zero-weight registration never sets that one).

  it(
    "the House earns no yield despite a funded budget, and a second register on the same zero-weight Player emits no further credit",
    async () => {
      const pool = await setupPool({ epochSeconds: 5, baseRateBps: 488 });
      const funder = await pool.fundedWallet(10_000_000n);
      await fundYield(pool, funder, 10_000_000n);

      await beginEpoch(pool, 0n); // epoch 1 open
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering, epoch 2 open

      // The House never held Principal (no round ran either, so it never
      // held Entries from a forfeit), so this is the idle branch at
      // principal 0: w == ps == 0, deterministically, no round timing needed.
      const sig1 = await register(pool, 1n, pool.operator.publicKey);
      const event1 = await findEvent<{
        epochId: BN;
        owner: PublicKey;
        amount: BN;
        shortfall: BN;
      }>(sig1, "yieldCredited");
      expect(event1?.epochId.toString()).toBe("1");
      expect(event1?.owner.toString()).toBe(pool.operator.publicKey.toString());
      expect(event1?.amount.toString()).toBe("0");
      expect(event1?.shortfall.toString()).toBe("0");

      const houseAfterFirst = await fetchPlayer(pool, pool.operator.publicKey);
      expect(houseAfterFirst.yieldEpoch.toString()).toBe("1");
      expect(houseAfterFirst.principal.toString()).toBe("0");

      // w == 0 means `register` never set `reg_epoch`, so a second call is
      // still permitted; `yield_epoch` alone must stop a second credit.
      const sig2 = await register(pool, 1n, pool.operator.publicKey);
      const event2 = await findEvent(sig2, "yieldCredited");
      expect(event2, "the yield_epoch guard skips the block entirely").toBeUndefined();

      const houseAfterSecond = await fetchPlayer(pool, pool.operator.publicKey);
      expect(houseAfterSecond.principal.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "register credits Base yield on time-weighted Principal for an idle depositor, funded by a non-admin fund_yield",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, baseRateBps: 488 });
      const a = await pool.fundedWallet(20_000_000_000n);
      const funder = await pool.fundedWallet(10_000_000_000n); // not pool.admin

      await deposit(pool, a, 10_000_000_000n);

      const fundSig = await fundYield(pool, funder, 5_000_000_000n);
      const fundEvent = await findEvent<{ amount: BN; budget: BN }>(fundSig, "yieldFunded");
      expect(fundEvent?.amount.toString()).toBe("5000000000");
      expect(fundEvent?.budget.toString()).toBe("5000000000");
      const vaultAfterFund = await program.provider.connection.getTokenAccountBalance(
        pool.principalVault,
      );
      expect(vaultAfterFund.value.amount).toBe("15000000000"); // the deposit plus the fund

      await beginEpoch(pool, 0n); // epoch 1 open, a idle throughout (deposited before it opened)
      await retryUntilOk(() => beginEpoch(pool, 1n)); // epoch1 -> Registering, epoch 2 open

      const epoch1 = await fetchEpoch(pool, 1n);
      const epochLen = BigInt(epoch1.endsAt.toString()) - BigInt(epoch1.startsAt.toString());
      const ps = 10_000_000_000n * epochLen;
      const expectedCredit = (ps * 488n) / (10_000n * 31_536_000n);
      expect(expectedCredit > 0n).toBe(true);

      const poolBefore = await program.account.pool.fetch(pool.pool);

      const sig = await register(pool, 1n, a.keypair.publicKey);
      const event = await findEvent<{
        epochId: BN;
        owner: PublicKey;
        amount: BN;
        shortfall: BN;
      }>(sig, "yieldCredited");
      expect(event?.amount.toString()).toBe(expectedCredit.toString());
      expect(event?.shortfall.toString()).toBe("0");

      const playerAfter = await fetchPlayer(pool, a.keypair.publicKey);
      expect(BigInt(playerAfter.principal.toString())).toBe(10_000_000_000n + expectedCredit);
      expect(BigInt(playerAfter.entries.toString())).toBe(10_000_000_000n + expectedCredit);
      expect(playerAfter.yieldEpoch.toString()).toBe("1");

      const poolAfter = await program.account.pool.fetch(pool.pool);
      expect(BigInt(poolAfter.totalPrincipal.toString())).toBe(
        BigInt(poolBefore.totalPrincipal.toString()) + expectedCredit,
      );
      expect(BigInt(poolAfter.yieldBudget.toString())).toBe(5_000_000_000n - expectedCredit);

      // The registered weight itself used the pre-credit Principal: the
      // credit lands after `w`/`ps` are read, so it cannot inflate the
      // lottery weight this same epoch already committed.
      const registeredWeight =
        BigInt(playerAfter.regEnd.toString()) - BigInt(playerAfter.regStart.toString());
      expect(registeredWeight).toBe(ps);
    },
    TIMEOUT,
  );

  it(
    "an empty yield budget credits 0 and reports the full shortfall, without blocking registration",
    async () => {
      const pool = await setupPool({ epochSeconds: 6, baseRateBps: 488 });
      const a = await pool.fundedWallet(20_000_000_000n);
      await deposit(pool, a, 10_000_000_000n); // before epoch 1 opens: idle branch

      await beginEpoch(pool, 0n);
      await retryUntilOk(() => beginEpoch(pool, 1n));

      const epoch1 = await fetchEpoch(pool, 1n);
      const epochLen = BigInt(epoch1.endsAt.toString()) - BigInt(epoch1.startsAt.toString());
      const ps = 10_000_000_000n * epochLen;
      const expectedDesired = (ps * 488n) / (10_000n * 31_536_000n);
      expect(expectedDesired > 0n).toBe(true);

      expect((await program.account.pool.fetch(pool.pool)).yieldBudget.toString()).toBe("0");

      const sig = await register(pool, 1n, a.keypair.publicKey);
      const event = await findEvent<{ amount: BN; shortfall: BN }>(sig, "yieldCredited");
      expect(event?.amount.toString()).toBe("0");
      expect(event?.shortfall.toString()).toBe(expectedDesired.toString());

      const playerAfter = await fetchPlayer(pool, a.keypair.publicKey);
      expect(playerAfter.principal.toString()).toBe("10000000000");
      expect(playerAfter.regEpoch.toString()).toBe("1");
      const registeredWeight =
        BigInt(playerAfter.regEnd.toString()) - BigInt(playerAfter.regStart.toString());
      expect(registeredWeight).toBe(ps);

      expect((await program.account.pool.fetch(pool.pool)).yieldBudget.toString()).toBe("0");
    },
    TIMEOUT,
  );
});
