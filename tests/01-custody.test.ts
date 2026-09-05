// Custody invariants: deposit/withdraw bounds, pause semantics, and the
// per-pool vault seeds (spec §2.3 "Custody", §2.4 invariants 1-4).
//
// Each test airdrops, mints, and confirms several transactions against a
// real localnet validator, so the default 5s vitest timeout is too tight.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { program, playerPda, setupPool, type PoolCtx } from "./helpers/hx.js";

const TIMEOUT = 30_000;

/** Every account `deposit` needs, for one pool and one wallet. */
function depositAccounts(pool: PoolCtx, owner: Awaited<ReturnType<PoolCtx["fundedWallet"]>>) {
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

/** Every account `withdraw` needs, for one pool and one wallet. */
function withdrawAccounts(pool: PoolCtx, owner: Awaited<ReturnType<PoolCtx["fundedWallet"]>>) {
  return {
    owner: owner.keypair.publicKey,
    pool: pool.pool,
    player: playerPda(pool.pool, owner.keypair.publicKey),
    acceptedMint: pool.mint,
    ownerToken: owner.tokenAccount,
    principalVault: pool.principalVault,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

async function deposit(pool: PoolCtx, owner: Awaited<ReturnType<PoolCtx["fundedWallet"]>>, amount: bigint) {
  return program.methods
    .deposit(new BN(amount.toString()))
    .accountsPartial(depositAccounts(pool, owner))
    .signers([owner.keypair])
    .rpc();
}

async function withdraw(pool: PoolCtx, owner: Awaited<ReturnType<PoolCtx["fundedWallet"]>>, amount: bigint) {
  return program.methods
    .withdraw(new BN(amount.toString()))
    .accountsPartial(withdrawAccounts(pool, owner))
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

describe("custody", () => {
  it(
    "deposit mints equal principal and entries",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);

      await deposit(pool, owner, 4_000_000n);

      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("4000000");
      expect(player.entries.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "withdraw enforces both principal and entries bounds",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 3_000_000n);

      await expect(withdraw(pool, owner, 3_000_001n)).rejects.toThrow();
      await expect(withdraw(pool, owner, 0n)).rejects.toThrow();

      await withdraw(pool, owner, 3_000_000n);
      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("0");
      expect(player.entries.toString()).toBe("0");
    },
    TIMEOUT,
  );

  it(
    "withdraw works while the pool is paused",
    async () => {
      const pool = await setupPool();
      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 2_000_000n);

      await setPause(pool, true);
      await withdraw(pool, owner, 1_000_000n);

      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("1000000");
    },
    TIMEOUT,
  );

  it(
    "deposit fails while paused and fails below the pool minimum",
    async () => {
      const pool = await setupPool({ minDeposit: 1_000_000 });
      const owner = await pool.fundedWallet(10_000_000n);

      await expect(deposit(pool, owner, 500_000n)).rejects.toThrow();

      await setPause(pool, true);
      await expect(deposit(pool, owner, 2_000_000n)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "keeps the vault balance equal to total_principal across a sequence",
    async () => {
      const pool = await setupPool();
      const alice = await pool.fundedWallet(10_000_000n);
      const bob = await pool.fundedWallet(10_000_000n);

      await deposit(pool, alice, 4_000_000n);
      await deposit(pool, bob, 6_000_000n);
      await withdraw(pool, alice, 1_000_000n);

      const poolAccount = await program.account.pool.fetch(pool.pool);
      const vaultBalance = await program.provider.connection.getTokenAccountBalance(pool.principalVault);

      expect(poolAccount.totalPrincipal.toString()).toBe("9000000");
      expect(vaultBalance.value.amount).toBe(poolAccount.totalPrincipal.toString());
    },
    TIMEOUT,
  );

  it(
    "deposit to the House fails with HouseCannotDeposit, but a normal deposit still succeeds",
    async () => {
      const pool = await setupPool();

      const authorityAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.authority,
        pool.mint,
        pool.authority.publicKey,
      );
      await mintTo(program.provider.connection, pool.authority, pool.mint, authorityAta.address, pool.authority, 5_000_000n);

      await expect(
        program.methods
          .deposit(new BN("2000000"))
          .accountsPartial({
            owner: pool.authority.publicKey,
            pool: pool.pool,
            player: pool.house,
            acceptedMint: pool.mint,
            ownerToken: authorityAta.address,
            principalVault: pool.principalVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.authority])
          .rpc(),
      ).rejects.toThrow();

      const owner = await pool.fundedWallet(10_000_000n);
      await deposit(pool, owner, 4_000_000n);
      const player = await program.account.player.fetch(playerPda(pool.pool, owner.keypair.publicKey));
      expect(player.principal.toString()).toBe("4000000");
    },
    TIMEOUT,
  );

  it(
    "rejects a foreign pool's vault by seeds",
    async () => {
      const poolA = await setupPool();
      const poolB = await setupPool({ mint: poolA.mint });
      const owner = await poolA.fundedWallet(10_000_000n);

      const accounts = depositAccounts(poolA, owner);
      accounts.principalVault = poolB.principalVault;

      await expect(
        program.methods.deposit(new BN("2000000")).accountsPartial(accounts).signers([owner.keypair]).rpc(),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );
});
