import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { HexVault, bn, longTimeouts, type Pool } from "./helpers/hx.ts";

const AMT = 1_000_000n;

/**
 * Swapping any account for a look-alike from another pool must fail in Anchor
 * constraint checks or in the program body, never silently.
 */
describe("account substitution: foreign pool state, wrong mints, wrong token programs", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let other: Pool;
  let epochId: bigint;
  /** Token-2022 mint that belongs to no pool at all. */
  let decoyMint: PublicKey;
  let decoyAta: PublicKey;

  beforeAll(async () => {
    hv = await HexVault.create();
    pool = await hv.createPool();
    other = await hv.createPool();
    const now = await hv.chainNow();

    const window = {
      id: 1n,
      startsAt: now - 20,
      entryCutoffAt: now + 120,
      endsAt: now + 240,
      prizeSnapshotAt: now + 240,
      claimDeadline: now + 480,
    };
    epochId = window.id;
    await pool.createFirstEpoch(window);
    await other.createFirstEpoch(window);
    await pool.deposit(hv.payer, AMT);
    await other.deposit(hv.payer, AMT);

    decoyMint = await createMint(
      hv.connection,
      hv.payer,
      hv.authority,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    decoyAta = getAssociatedTokenAddressSync(
      decoyMint,
      hv.authority,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    // the ATA must exist so the mint-identity constraint is what fires
    await sendAndConfirmTransaction(
      hv.connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          hv.authority,
          decoyAta,
          hv.authority,
          decoyMint,
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
      [hv.payer],
    );
  });

  it("rejects a withdrawal paid from another pool's principal vault", async () => {
    await expect(
      hv.program.methods
        .withdraw(bn(1n))
        .accounts({
          ...pool.withdrawAccounts(hv.authority),
          principalVault: other.principalVault,
        })
        .rpc(),
    ).rejects.toThrow("PoolMismatch");
  });

  it("rejects a withdrawal against a receipt mint instead of the accepted asset", async () => {
    await expect(
      hv.program.methods
        .withdraw(bn(1n))
        .accounts({
          ...pool.withdrawAccounts(hv.authority),
          acceptedMint: pool.principalMint,
          ownerAccepted: pool.principalAta(hv.authority),
        })
        .rpc(),
      // Anchor rejects the wrong token-account/mint pairing before the
      // program's own PoolMismatch check runs
    ).rejects.toThrow(/PoolMismatch|Constraint/);
  });

  it("rejects a withdrawal that names the classic token program for receipts", async () => {
    await expect(
      hv.program.methods
        .withdraw(bn(1n))
        .accounts({
          ...pool.withdrawAccounts(hv.authority),
          receiptTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      // Anchor rejects the classic token program before the program body
    ).rejects.toThrow(
      /ConstraintAddress|ReceiptConfigurationMismatch|ConstraintAssociatedToken/,
    );
  });

  it("rejects a deposit against an epoch of another pool", async () => {
    await expect(
      hv.program.methods
        .deposit(bn(1n))
        .accounts({
          ...pool.depositAccounts(hv.authority, epochId),
          epoch: other.epoch(epochId),
        })
        .rpc(),
      // the epoch PDA is derived from the supplied pool key
    ).rejects.toThrow(/ConstraintSeeds|PoolMismatch|AccountNotInitialized/);
  });

  it("rejects a deposit with a player account derived for another pool", async () => {
    await expect(
      hv.program.methods
        .deposit(bn(1n))
        .accounts({
          ...pool.depositAccounts(hv.authority, epochId),
          player: other.player(hv.authority),
        })
        .rpc(),
    ).rejects.toThrow(/ConstraintSeeds/);
  });

  it("rejects a deposit whose accepted mint is a receipt mint", async () => {
    await expect(
      hv.program.methods
        .deposit(bn(1n))
        .accounts({
          ...pool.depositAccounts(hv.authority, epochId),
          acceptedMint: decoyMint,
          ownerAccepted: decoyAta,
          acceptedTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc(),
      // the pool's immutable accepted asset identity wins over any stand-in
    ).rejects.toThrow(/PoolMismatch|Constraint/);
  });

  it("rejects a deposit whose receipt token program is the classic token program", async () => {
    await expect(
      hv.program.methods
        .deposit(bn(1n))
        .accounts({
          ...pool.depositAccounts(hv.authority, epochId),
          receiptTokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc(),
      // the associated-token constraint fires before the program body
    ).rejects.toThrow(
      /ConstraintAddress|ReceiptConfigurationMismatch|ConstraintAssociatedToken/,
    );
  });

  it("leaves both pools untouched after the rejected calls", async () => {
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT);
    expect(await other.vaultBalance(other.principalVault)).toBe(AMT);
    expect(await pool.principalBalance(hv.authority)).toBe(AMT);
    expect(await pool.entryBalance(hv.authority)).toBe(AMT);
    expect(await other.principalBalance(hv.authority)).toBe(AMT);
  });
});
