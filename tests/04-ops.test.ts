// Ops-and-envs program tickets: shutdown (ReduceOnly), the permissionless
// emergency_withdraw and close_round cranks, and the admin's sweep_house
// (docs/plan/ops-and-envs/issues/02-05).
//
// Every test runs against a real localnet validator, so give it room.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import {
  DEVNET_VRF_NETWORK_STATE,
  DEVNET_VRF_TREASURY,
  epochPda,
  findEvent,
  fulfillRandomness,
  playerPda,
  positionPda,
  program,
  retryUntilOk,
  roundPda,
  setupPool,
  type PoolCtx,
} from "./helpers/hx.js";

const TIMEOUT = 60_000;

// ORAO's VRF program id, pinned on the pool at create_pool. test-vrf never
// actually invokes it, so it needs no deployment on localnet; closeRegistration
// still checks the account's address against this constant.
const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

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

async function setPause(pool: PoolCtx, signer: Keypair, paused: boolean) {
  return program.methods
    .setPause(paused)
    .accountsPartial({ signer: signer.publicKey, pool: pool.pool })
    .signers([signer])
    .rpc();
}

async function shutdown(pool: PoolCtx, admin: Keypair = pool.admin) {
  return program.methods
    .shutdown()
    .accountsPartial({ admin: admin.publicKey, pool: pool.pool })
    .signers([admin])
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

async function buyTickets(pool: PoolCtx, owner: Wallet, amount: bigint) {
  return program.methods
    .buyTickets(new BN(amount.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      acceptedMint: pool.mint,
      ownerToken: owner.tokenAccount,
      jackpotVault: pool.jackpotVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner.keypair])
    .rpc();
}

async function grantTickets(pool: PoolCtx, signer: Keypair, owner: PublicKey, amount: bigint) {
  return program.methods
    .grantTickets(new BN(amount.toString()))
    .accountsPartial({
      signer: signer.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner),
    })
    .signers([signer])
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

async function payout(pool: PoolCtx, epochId: bigint, winner: PublicKey) {
  return program.methods
    .payout()
    .accountsPartial({
      pool: pool.pool,
      acceptedMint: pool.mint,
      epoch: epochPda(pool.pool, epochId),
      winner: playerPda(pool.pool, winner),
      jackpotVault: pool.jackpotVault,
      principalVault: pool.principalVault,
      treasury: pool.treasury,
      buybackReserve: pool.buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

async function createRound(
  pool: PoolCtx,
  currentEpochId: bigint,
  roundId: bigint,
  startsAt: number,
  endsAt: number,
) {
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

async function buyPosition(
  pool: PoolCtx,
  owner: Wallet,
  roundId: bigint,
  tiles: bigint,
  stakePerTile: bigint,
) {
  return program.methods
    .buyPosition(new BN(tiles.toString()), new BN(stakePerTile.toString()))
    .accountsPartial({
      owner: owner.keypair.publicKey,
      pool: pool.pool,
      player: playerPda(pool.pool, owner.keypair.publicKey),
      round: roundPda(pool.pool, roundId),
      position: positionPda(roundPda(pool.pool, roundId), owner.keypair.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([owner.keypair])
    .rpc();
}

async function fetchPlayer(pool: PoolCtx, owner: PublicKey) {
  return program.account.player.fetch(playerPda(pool.pool, owner));
}

async function fetchEpoch(pool: PoolCtx, epochId: bigint) {
  return program.account.epoch.fetch(epochPda(pool.pool, epochId));
}

const vaultBalance = async (account: PublicKey): Promise<bigint> =>
  BigInt((await program.provider.connection.getTokenAccountBalance(account)).value.amount);

async function adminAta(pool: PoolCtx): Promise<PublicKey> {
  return (
    await getOrCreateAssociatedTokenAccount(
      program.provider.connection,
      pool.operator,
      pool.mint,
      pool.admin.publicKey,
    )
  ).address;
}

async function adminWithdraw(pool: PoolCtx, adminToken: PublicKey, amount: bigint) {
  return program.methods
    .adminWithdraw(new BN(amount.toString()))
    .accountsPartial({
      admin: pool.admin.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      adminToken,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([pool.admin])
    .rpc();
}

async function emergencyWithdraw(
  pool: PoolCtx,
  owner: PublicKey,
  ownerToken: PublicKey,
) {
  return program.methods
    .emergencyWithdraw()
    .accountsPartial({
      pool: pool.pool,
      player: playerPda(pool.pool, owner),
      owner,
      acceptedMint: pool.mint,
      ownerToken,
      principalVault: pool.principalVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

async function sweepHouse(pool: PoolCtx, admin: Keypair = pool.admin) {
  return program.methods
    .sweepHouse()
    .accountsPartial({
      admin: admin.publicKey,
      pool: pool.pool,
      acceptedMint: pool.mint,
      jackpotVault: pool.jackpotVault,
      principalVault: pool.principalVault,
      treasury: pool.treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([admin])
    .rpc();
}

describe("shutdown", () => {
  it(
    "flips shutdown and paused, refuses a second call, emits PoolShutdown, and only the admin may call it",
    async () => {
      const pool = await setupPool();

      await expect(shutdown(pool, pool.operator)).rejects.toThrow(/ConstraintHasOne/);

      const sig = await shutdown(pool);
      const account = await program.account.pool.fetch(pool.pool);
      expect(account.shutdown).toBe(true);
      expect(account.paused).toBe(true);

      const event = await findEvent<{ pool: PublicKey; at: BN }>(sig, "poolShutdown");
      expect(event?.pool.toBase58()).toBe(pool.pool.toBase58());

      await expect(shutdown(pool)).rejects.toThrow(/PoolShutDown/);
    },
    TIMEOUT,
  );

  it(
    "set_pause(false) refuses once shut down, but set_pause(true) is still accepted",
    async () => {
      const pool = await setupPool();
      await shutdown(pool);

      await expect(setPause(pool, pool.admin, false)).rejects.toThrow(/PoolShutDown/);
      await setPause(pool, pool.admin, true); // no-op, still allowed
    },
    TIMEOUT,
  );

  it(
    "request_withdraw and process_withdraw pay out in one transaction once shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      await requestWithdraw(pool, owner, 4_000_000n);
      await processWithdraw(pool, owner); // would otherwise fail WithdrawalNotDue
      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
    },
    TIMEOUT,
  );

  it(
    "payout of an epoch already Drawn before shutdown still pays",
    async () => {
      const pool = await setupPool({ epochSeconds: 6 });
      await beginEpoch(pool, 0n);

      const a = await pool.fundedWallet(10_000_000n);
      await deposit(pool, a, 4_000_000n);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundJackpot(pool, funder, 2_000_000n);

      await retryUntilOk(() => beginEpoch(pool, 1n));
      await register(pool, 1n, a.keypair.publicKey);
      await closeRegistration(pool, 1n);

      const closed = await fetchEpoch(pool, 1n);
      const randomness = await fulfillRandomness(Uint8Array.from(closed.vrfSeed));
      await draw(pool, 1n, randomness);

      await shutdown(pool);

      const before = await fetchPlayer(pool, a.keypair.publicKey);
      await payout(pool, 1n, a.keypair.publicKey);
      const after = await fetchPlayer(pool, a.keypair.publicKey);
      expect(BigInt(after.principal.toString()) - BigInt(before.principal.toString())).toBe(
        2_000_000n,
      );
    },
    TIMEOUT,
  );

  it(
    "every shutdown-refused instruction fails once the pool is shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 5_000_000n);

      // A round and an epoch that both legitimately exist before shutdown,
      // so the accounts passed below satisfy Anchor's own seed/bump checks
      // and the program's `require!(!pool.shutdown, ...)` -- the very first
      // check in every one of these handlers -- is what actually fires.
      const roundId = 1n;
      await createRound(pool, 0n, roundId, 0, 60);
      await beginEpoch(pool, 0n);

      await shutdown(pool);

      await expect(deposit(pool, owner, 1_000_000n)).rejects.toThrow(/PoolShutDown/);
      await expect(buyTickets(pool, owner, 1_000_000n)).rejects.toThrow(/PoolShutDown/);
      await expect(
        grantTickets(pool, pool.operator, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/PoolShutDown/);
      await expect(
        grantTickets(pool, pool.admin, owner.keypair.publicKey, 1n),
      ).rejects.toThrow(/PoolShutDown/);
      await expect(createRound(pool, 1n, 2n, 0, 60)).rejects.toThrow(/PoolShutDown/);
      await expect(buyPosition(pool, owner, roundId, 1n, 1n)).rejects.toThrow(/PoolShutDown/);
      await expect(beginEpoch(pool, 1n)).rejects.toThrow(/PoolShutDown/);
      await expect(closeRegistration(pool, 1n)).rejects.toThrow(/PoolShutDown/);
      await expect(draw(pool, 1n, pool.pool)).rejects.toThrow(/PoolShutDown/);
      await expect(fundYield(pool, owner, 1_000_000n)).rejects.toThrow(/PoolShutDown/);
    },
    TIMEOUT,
  );
});

describe("emergency_withdraw", () => {
  it(
    "refuses while the pool is not shut down",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);

      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount),
      ).rejects.toThrow(/PoolNotShutDown/);
    },
    TIMEOUT,
  );

  it(
    "pays principal only, entries and principal zero out, total_principal drops",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      const sig = await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);

      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("0");
      expect(player.entries.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).totalPrincipal.toString()).toBe("0");

      const event = await findEvent<{ principal: BN; pending: BN; total: BN }>(
        sig,
        "emergencyWithdrawn",
      );
      expect(event?.principal.toString()).toBe("4000000");
      expect(event?.pending.toString()).toBe("0");
      expect(event?.total.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "pays pending only, and both principal and pending together",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await requestWithdraw(pool, owner, 1_500_000n); // 2.5M principal, 1.5M pending
      await shutdown(pool);

      const walletBefore = await vaultBalance(owner.tokenAccount);
      await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);

      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore + 4_000_000n);
      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("0");
      expect(player.pendingWithdraw.toString()).toBe("0");
      expect((await program.account.pool.fetch(pool.pool)).pendingWithdrawals.toString()).toBe(
        "0",
      );
    },
    TIMEOUT,
  );

  it(
    "a short vault fails with InsufficientVault and pays nothing",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);
      await adminWithdraw(pool, await adminAta(pool), 4_000_000n); // vault now empty

      const walletBefore = await vaultBalance(owner.tokenAccount);
      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount),
      ).rejects.toThrow(/InsufficientVault/);

      expect(await vaultBalance(owner.tokenAccount)).toBe(walletBefore);
      const player = await fetchPlayer(pool, owner.keypair.publicKey);
      expect(player.principal.toString()).toBe("4000000"); // unchanged: the whole tx reverted
    },
    TIMEOUT,
  );

  it(
    "the House refuses, even though it holds no principal",
    async () => {
      const pool = await setupPool();
      await shutdown(pool);
      const operatorAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );

      await expect(
        emergencyWithdraw(pool, pool.operator.publicKey, operatorAta.address),
      ).rejects.toThrow(/HouseCannotEmergencyWithdraw/);
    },
    TIMEOUT,
  );

  it(
    "a wrong ATA owner refuses, and a second call on a zero balance refuses",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      const stranger = await pool.fundedWallet(0n);
      await deposit(pool, owner, 4_000_000n);
      await shutdown(pool);

      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, stranger.tokenAccount),
      ).rejects.toThrow();

      await emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount);
      await expect(
        emergencyWithdraw(pool, owner.keypair.publicKey, owner.tokenAccount),
      ).rejects.toThrow(/ZeroAmount/);
    },
    TIMEOUT,
  );
});

describe("sweep_house", () => {
  it(
    "refuses while the pool is not shut down, and refuses the operator",
    async () => {
      const pool = await setupPool();
      await expect(sweepHouse(pool)).rejects.toThrow(/PoolNotShutDown/);

      await shutdown(pool);
      await expect(sweepHouse(pool, pool.operator)).rejects.toThrow(/ConstraintHasOne/);
    },
    TIMEOUT,
  );

  it(
    "sweeps the whole jackpot and the unspent yield budget, leaving the principal vault at total_principal + pending_withdrawals",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      await requestWithdraw(pool, owner, 1_000_000n); // 3M principal, 1M pending

      const funder = await pool.fundedWallet(10_000_000n);
      await fundYield(pool, funder, 500_000n);
      await fundJackpot(pool, funder, 2_000_000n);
      await shutdown(pool);

      const treasuryBefore = await vaultBalance(pool.treasury);
      const sig = await sweepHouse(pool);

      expect(await vaultBalance(pool.jackpotVault)).toBe(0n);
      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore + 2_500_000n);
      expect(await vaultBalance(pool.principalVault)).toBe(4_000_000n); // 3M + 1M
      expect((await program.account.pool.fetch(pool.pool)).yieldBudget.toString()).toBe("0");

      const event = await findEvent<{ jackpot: BN; yieldBudget: BN }>(sig, "houseSwept");
      expect(event?.jackpot.toString()).toBe("2000000");
      expect(event?.yieldBudget.toString()).toBe("500000");

      // Callable again: a later fund_jackpot can be swept a second time.
      await fundJackpot(pool, funder, 100_000n);
      await sweepHouse(pool);
      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore + 2_600_000n);
    },
    TIMEOUT,
  );

  it(
    "with principal pulled out via admin_withdraw, the yield-budget sweep is capped at the real surplus",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);

      const funder = await pool.fundedWallet(10_000_000n);
      await fundYield(pool, funder, 500_000n);
      // Vault now holds 4.5M (4M principal + 0.5M yield budget). Pulling all
      // 4.5M out leaves the vault at exactly total_principal (4M is still
      // owed once returned) -- no surplus above obligations remains.
      await adminWithdraw(pool, await adminAta(pool), 4_500_000n);
      await shutdown(pool);

      const treasuryBefore = await vaultBalance(pool.treasury);
      const sig = await sweepHouse(pool);

      expect(await vaultBalance(pool.treasury)).toBe(treasuryBefore); // nothing to sweep
      expect((await program.account.pool.fetch(pool.pool)).yieldBudget.toString()).toBe("0");
      const event = await findEvent<{ jackpot: BN; yieldBudget: BN }>(sig, "houseSwept");
      expect(event?.yieldBudget.toString()).toBe("0");
    },
    TIMEOUT,
  );
});
