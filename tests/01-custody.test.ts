// Custody invariants: deposit/withdraw bounds, pause semantics, and the
// per-pool vault seeds (spec §2.3 "Custody", §2.4 invariants 1-4).
//
// Each test airdrops, mints, and confirms several transactions against a
// real localnet validator, so the default 5s vitest timeout is too tight.

import { describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  epochPda,
  findEvent,
  onChainNowSeconds,
  playerPda,
  program,
  roundPda,
  setupPool,
  type PoolCtx,
} from "./helpers/hx.js";

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
    .accountsPartial({ signer: pool.admin.publicKey, pool: pool.pool })
    .signers([pool.admin])
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

      const operatorAta = await getOrCreateAssociatedTokenAccount(
        program.provider.connection,
        pool.operator,
        pool.mint,
        pool.operator.publicKey,
      );
      await mintTo(program.provider.connection, pool.operator, pool.mint, operatorAta.address, pool.operator, 5_000_000n);

      await expect(
        program.methods
          .deposit(new BN("2000000"))
          .accountsPartial({
            owner: pool.operator.publicKey,
            pool: pool.pool,
            player: pool.house,
            acceptedMint: pool.mint,
            ownerToken: operatorAta.address,
            principalVault: pool.principalVault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([pool.operator])
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

// --- Roles (ticket 01) ---------------------------------------------------
//
// Anchor deserializes every account before it runs a single constraint, so
// the matrix needs Epoch 1 and Round 1 to exist or the wrong signer is
// masked by AccountNotInitialized. `rolePool` opens both; the accounts after
// them in each struct are never read, so any address fills those slots.

const ORAO_VRF_PROGRAM_ID = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

const NO_PARAMS = {
  epochSeconds: null,
  epochAnchor: null,
  roundSeconds: null,
  closeBuffer: null,
  vrfTimeout: null,
  minDeposit: null,
  houseCutBps: null,
};

/** A funded throwaway key. The `init` accounts on the operator-gated
 *  instructions charge rent to the signer before the role constraint runs,
 *  so a broke wrong signer would fail on lamports instead of on the role. */
async function fundedKey(): Promise<Keypair> {
  const keypair = Keypair.generate();
  const connection = program.provider.connection;
  await connection.confirmTransaction(
    await connection.requestAirdrop(keypair.publicKey, 2_000_000_000),
    "confirmed",
  );
  return keypair;
}

/** A pool with Epoch 1 open and Round 1 created, both by the real operator. */
async function rolePool(): Promise<PoolCtx> {
  const pool = await setupPool({ roundSeconds: 60 });
  await program.methods
    .beginEpoch()
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, 0n),
      newEpoch: epochPda(pool.pool, 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();

  const startsAt = await onChainNowSeconds();
  await program.methods
    .createRound(new BN(startsAt), new BN(startsAt + 60))
    .accountsPartial({
      operator: pool.operator.publicKey,
      pool: pool.pool,
      currentEpoch: epochPda(pool.pool, 1n),
      round: roundPda(pool.pool, 1n),
      systemProgram: SystemProgram.programId,
    })
    .signers([pool.operator])
    .rpc();
  return pool;
}

/** Every operator-gated instruction, built with `signer` in the operator slot. */
function operatorGated(pool: PoolCtx, signer: PublicKey) {
  const filler = pool.pool;
  const epoch = epochPda(pool.pool, 1n);
  const round = roundPda(pool.pool, 1n);
  const m = program.methods;
  return {
    // Round 1 is already open, so this one is aimed at the next id.
    createRound: m.createRound(new BN(0), new BN(60)).accountsPartial({
      operator: signer,
      pool: pool.pool,
      currentEpoch: epoch,
      round: roundPda(pool.pool, 2n),
      systemProgram: SystemProgram.programId,
    }),
    settleRound: m.settleRound().accountsPartial({
      operator: signer,
      pool: pool.pool,
      round,
      randomness: filler,
      house: pool.house,
    }),
    voidRound: m.voidRound().accountsPartial({ operator: signer, pool: pool.pool, round }),
    beginEpoch: m.beginEpoch().accountsPartial({
      operator: signer,
      pool: pool.pool,
      currentEpoch: epoch,
      newEpoch: epochPda(pool.pool, 2n),
      systemProgram: SystemProgram.programId,
    }),
    closeRegistration: m.closeRegistration().accountsPartial({
      operator: signer,
      pool: pool.pool,
      epoch,
      jackpotVault: pool.jackpotVault,
      randomness: filler,
      vrfNetworkState: filler,
      vrfTreasury: filler,
      vrfProgram: ORAO_VRF_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }),
    draw: m.draw().accountsPartial({ operator: signer, pool: pool.pool, epoch, randomness: filler }),
    payout: m.payout().accountsPartial({
      operator: signer,
      pool: pool.pool,
      acceptedMint: pool.mint,
      epoch,
      winner: pool.house,
      jackpotVault: pool.jackpotVault,
      // Any token account of the accepted mint that is not already in this
      // struct: a repeat would trip the duplicate-mutable check first.
      winnerToken: pool.principalVault,
      treasury: pool.treasury,
      buybackReserve: pool.buybackReserve,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
    rolloverEpoch: m.rolloverEpoch().accountsPartial({ operator: signer, pool: pool.pool, epoch }),
  };
}

/** Every admin-gated instruction, built with `signer` in the admin slot. */
function adminGated(pool: PoolCtx, signer: PublicKey) {
  const m = program.methods;
  return {
    setParams: m.setParams(NO_PARAMS).accountsPartial({ admin: signer, pool: pool.pool }),
    setOperator: m
      .setOperator(Keypair.generate().publicKey)
      .accountsPartial({ admin: signer, pool: pool.pool }),
    proposeAdmin: m
      .proposeAdmin(Keypair.generate().publicKey)
      .accountsPartial({ admin: signer, pool: pool.pool }),
  };
}

describe("roles", () => {
  it(
    "create_pool records both roles, no pending handover, and the House belongs to the operator",
    async () => {
      const pool = await setupPool();

      const account = await program.account.pool.fetch(pool.pool);
      expect(account.admin.toBase58()).toBe(pool.admin.publicKey.toBase58());
      expect(account.operator.toBase58()).toBe(pool.operator.publicKey.toBase58());
      expect(account.pendingAdmin.toBase58()).toBe(PublicKey.default.toBase58());
      expect((await program.account.player.fetch(pool.house)).owner.toBase58()).toBe(
        pool.operator.publicKey.toBase58(),
      );
    },
    TIMEOUT,
  );

  it(
    "every operator-gated instruction rejects the admin and a stranger",
    async () => {
      const pool = await rolePool();
      const stranger = await fundedKey();

      for (const wrong of [pool.admin, stranger]) {
        for (const [name, builder] of Object.entries(operatorGated(pool, wrong.publicKey))) {
          await expect(builder.signers([wrong]).rpc(), name).rejects.toThrow(/ConstraintHasOne/);
        }
      }
    },
    TIMEOUT,
  );

  it(
    "every admin-gated instruction rejects the operator and a stranger",
    async () => {
      const pool = await setupPool();
      const stranger = await fundedKey();

      for (const wrong of [pool.operator, stranger]) {
        for (const [name, builder] of Object.entries(adminGated(pool, wrong.publicKey))) {
          await expect(builder.signers([wrong]).rpc(), name).rejects.toThrow(/ConstraintHasOne/);
        }
      }
    },
    TIMEOUT,
  );

  it(
    "pause takes the admin or the operator, unpause takes only the admin",
    async () => {
      const pool = await setupPool();
      const stranger = await fundedKey();
      const setPauseBy = (signer: typeof pool.admin, paused: boolean) =>
        program.methods
          .setPause(paused)
          .accountsPartial({ signer: signer.publicKey, pool: pool.pool })
          .signers([signer])
          .rpc();

      await setPauseBy(pool.operator, true);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);

      await expect(setPauseBy(pool.operator, false)).rejects.toThrow(/Unauthorized/);
      await expect(setPauseBy(stranger, true)).rejects.toThrow(/Unauthorized/);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);

      await setPauseBy(pool.admin, false);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(false);

      await setPauseBy(pool.admin, true);
      expect((await program.account.pool.fetch(pool.pool)).paused).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "set_operator rotates the crank key and locks the old one out",
    async () => {
      const pool = await rolePool();
      const next = Keypair.generate();

      const signature = await program.methods
        .setOperator(next.publicKey)
        .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
        .signers([pool.admin])
        .rpc();

      expect((await program.account.pool.fetch(pool.pool)).operator.toBase58()).toBe(
        next.publicKey.toBase58(),
      );
      const event = await findEvent<{ previous: PublicKey; operator: PublicKey }>(
        signature,
        "operatorChanged",
      );
      expect(event?.previous.toBase58()).toBe(pool.operator.publicKey.toBase58());
      expect(event?.operator.toBase58()).toBe(next.publicKey.toBase58());

      await expect(
        operatorGated(pool, pool.operator.publicKey)
          .beginEpoch.signers([pool.operator])
          .rpc(),
      ).rejects.toThrow(/ConstraintHasOne/);
    },
    TIMEOUT,
  );

  it(
    "propose_admin then accept_admin hands the role over in two steps",
    async () => {
      const pool = await setupPool();
      const wrong = Keypair.generate();
      const next = await fundedKey();
      const acceptBy = (signer: typeof next) =>
        program.methods
          .acceptAdmin()
          .accountsPartial({ pendingAdmin: signer.publicKey, pool: pool.pool })
          .signers([signer])
          .rpc();

      // Nothing proposed yet.
      await expect(acceptBy(next)).rejects.toThrow(/NoPendingAdmin/);

      const proposeTo = (candidate: PublicKey) =>
        program.methods
          .proposeAdmin(candidate)
          .accountsPartial({ admin: pool.admin.publicKey, pool: pool.pool })
          .signers([pool.admin])
          .rpc();

      // A second proposal replaces the first, so the typo never lands.
      await proposeTo(wrong.publicKey);
      const proposal = await proposeTo(next.publicKey);
      expect(
        (
          await findEvent<{ pendingAdmin: PublicKey }>(proposal, "adminProposed")
        )?.pendingAdmin.toBase58(),
      ).toBe(next.publicKey.toBase58());
      expect((await program.account.pool.fetch(pool.pool)).pendingAdmin.toBase58()).toBe(
        next.publicKey.toBase58(),
      );

      await expect(acceptBy(wrong)).rejects.toThrow(/Unauthorized/);

      const handover = await acceptBy(next);
      const changed = await findEvent<{ previous: PublicKey; admin: PublicKey }>(
        handover,
        "adminChanged",
      );
      expect(changed?.previous.toBase58()).toBe(pool.admin.publicKey.toBase58());
      expect(changed?.admin.toBase58()).toBe(next.publicKey.toBase58());

      const account = await program.account.pool.fetch(pool.pool);
      expect(account.admin.toBase58()).toBe(next.publicKey.toBase58());
      expect(account.pendingAdmin.toBase58()).toBe(PublicKey.default.toBase58());

      // The old admin is now just another wrong signer.
      await expect(
        adminGated(pool, pool.admin.publicKey).setParams.signers([pool.admin]).rpc(),
      ).rejects.toThrow(/ConstraintHasOne/);
      await program.methods
        .setParams(NO_PARAMS)
        .accountsPartial({ admin: next.publicKey, pool: pool.pool })
        .signers([next])
        .rpc();
    },
    TIMEOUT,
  );
});
