import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import idl from "../target/idl/hex_vault.json" with { type: "json" };

const programId = new PublicKey(idl.address);
const amount = 1_000_000n;
const upgradeableLoader = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const programData = PublicKey.findProgramAddressSync(
  [programId.toBuffer()],
  upgradeableLoader,
)[0];

const pda = (seed: string, extra: Buffer[] = []): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), ...extra], programId)[0];

describe("HexVault custody flow", () => {
  const provider = AnchorProvider.env();
  // Anchor generates the method namespace from the runtime IDL.
  const program = new Program(idl, provider) as any;
  const authority = provider.wallet.publicKey;
  const config = pda("config");
  const principalMint = Keypair.generate();
  const entryMint = Keypair.generate();
  const epochId = new BN(1);
  const epoch = pda("epoch", [epochId.toArrayLike(Buffer, "le", 8)]);
  const player = pda("player", [authority.toBuffer()]);
  const roundId = new BN(1);
  const round = pda("round", [
    epoch.toBuffer(),
    roundId.toArrayLike(Buffer, "le", 8),
  ]);
  const position = pda("position", [round.toBuffer(), authority.toBuffer()]);

  let usdcMint: PublicKey;
  let ownerUsdc: PublicKey;
  let principalVault: PublicKey;
  let prizeVault: PublicKey;
  let ownerPrincipal: PublicKey;
  let ownerEntry: PublicKey;

  beforeAll(async () => {
    if (!provider.wallet.payer)
      throw new Error("local provider must expose a payer keypair");

    usdcMint = await createMint(
      provider.connection,
      provider.wallet.payer,
      authority,
      null,
      6,
    );
    ownerUsdc = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        provider.wallet.payer,
        usdcMint,
        authority,
      )
    ).address;
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      usdcMint,
      ownerUsdc,
      authority,
      amount * 3n,
    );

    principalVault = pda("principal-vault");
    prizeVault = pda("prize-vault");

    const attacker = Keypair.generate();
    const attackerPrincipalMint = Keypair.generate();
    const attackerEntryMint = Keypair.generate();
    const airdrop = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2_000_000_000,
    );
    await provider.connection.confirmTransaction(airdrop, "confirmed");
    await expect(
      program.methods
        .initialize({
          guardian: attacker.publicKey,
          snapshotAuthority: attacker.publicKey,
          mockRandomnessAuthority: attacker.publicKey,
          minDeposit: new BN(1),
          maxStakePerTile: new BN(amount.toString()),
          roundCloseBufferSeconds: new BN(0),
        })
        .accounts({
          authority: attacker.publicKey,
          config,
          program: programId,
          programData,
          usdcMint,
          usdcTokenProgram: TOKEN_PROGRAM_ID,
          receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
          principalMint: attackerPrincipalMint.publicKey,
          entryMint: attackerEntryMint.publicKey,
          principalVault,
          prizeVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker, attackerPrincipalMint, attackerEntryMint])
        .rpc(),
    ).rejects.toThrow("UnauthorizedAuthority");

    await program.methods
      .initialize({
        guardian: authority,
        snapshotAuthority: authority,
        mockRandomnessAuthority: authority,
        minDeposit: new BN(1),
        maxStakePerTile: new BN(amount.toString()),
        roundCloseBufferSeconds: new BN(0),
      })
      .accounts({
        authority,
        config,
        program: programId,
        programData,
        usdcMint,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        principalMint: principalMint.publicKey,
        entryMint: entryMint.publicKey,
        principalVault,
        prizeVault,
        systemProgram: SystemProgram.programId,
      })
      .signers([principalMint, entryMint])
      .rpc();

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createFirstEpoch({
        id: epochId,
        startsAt: new BN(now - 30),
        endsAt: new BN(now + 3_600),
        prizeSnapshotAt: new BN(now + 3_600),
        claimDeadline: new BN(now + 7_200),
      })
      .accounts({
        authority,
        config,
        epoch,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    ownerPrincipal = getAssociatedTokenAddressSync(
      principalMint.publicKey,
      authority,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    ownerEntry = getAssociatedTokenAddressSync(
      entryMint.publicKey,
      authority,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  });

  it("rejects an unconfigured guardian without changing protocol state", async () => {
    const attacker = Keypair.generate();

    await expect(
      program.methods
        .setPause(true)
        .accounts({ guardian: attacker.publicKey, config })
        .signers([attacker])
        .rpc(),
    ).rejects.toThrow("UnauthorizedGuardian");
  });

  it("mints matched PT/ET only after USDC enters the principal vault", async () => {
    await program.methods
      .deposit(new BN(amount.toString()))
      .accounts({
        owner: authority,
        config,
        epoch,
        player,
        usdcMint,
        ownerUsdc,
        principalVault,
        principalMint: principalMint.publicKey,
        entryMint: entryMint.publicKey,
        ownerPrincipal,
        ownerEntry,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    expect((await getAccount(provider.connection, principalVault)).amount).toBe(
      amount,
    );
    expect(
      (
        await getAccount(
          provider.connection,
          ownerPrincipal,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(amount);
    expect(
      (
        await getAccount(
          provider.connection,
          ownerEntry,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(amount);
  });

  it("keeps sponsor prize funding segregated from principal", async () => {
    await program.methods
      .fundPrize(new BN(amount.toString()))
      .accounts({
        funder: authority,
        config,
        usdcMint,
        funderUsdc: ownerUsdc,
        prizeVault,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    expect((await getAccount(provider.connection, principalVault)).amount).toBe(
      amount,
    );
    expect((await getAccount(provider.connection, prizeVault)).amount).toBe(
      amount,
    );
  });

  it("blocks withdrawals after ET is spent on a position", async () => {
    await program.methods
      .deposit(new BN(amount.toString()))
      .accounts({
        owner: authority,
        config,
        epoch,
        player,
        usdcMint,
        ownerUsdc,
        principalVault,
        principalMint: principalMint.publicKey,
        entryMint: entryMint.publicKey,
        ownerPrincipal,
        ownerEntry,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createRound(roundId, new BN(now - 10), new BN(now + 60), new BN(0))
      .accounts({
        authority,
        config,
        epoch,
        round,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await program.methods
      .buyPosition(new BN(1), new BN(amount.toString()))
      .accounts({
        owner: authority,
        config,
        epoch,
        player,
        round,
        position,
        principalMint: principalMint.publicKey,
        entryMint: entryMint.publicKey,
        ownerEntry,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await expect(
      program.methods
        .withdraw(new BN((amount * 2n).toString()))
        .accounts({
          owner: authority,
          config,
          usdcMint,
          ownerUsdc,
          principalVault,
          principalMint: principalMint.publicKey,
          entryMint: entryMint.publicKey,
          ownerPrincipal,
          ownerEntry,
          usdcTokenProgram: TOKEN_PROGRAM_ID,
          receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc(),
    ).rejects.toThrow("InsufficientMatchedBalance");

    expect((await getAccount(provider.connection, principalVault)).amount).toBe(
      amount * 2n,
    );
    expect(
      (
        await getAccount(
          provider.connection,
          ownerPrincipal,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(amount * 2n);
    expect(
      (
        await getAccount(
          provider.connection,
          ownerEntry,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(amount);
  });

  it("requires matched PT and ET, then returns only backed principal", async () => {
    await program.methods
      .withdraw(new BN(amount.toString()))
      .accounts({
        owner: authority,
        config,
        usdcMint,
        ownerUsdc,
        principalVault,
        principalMint: principalMint.publicKey,
        entryMint: entryMint.publicKey,
        ownerPrincipal,
        ownerEntry,
        usdcTokenProgram: TOKEN_PROGRAM_ID,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    expect((await getAccount(provider.connection, principalVault)).amount).toBe(
      amount,
    );
    expect((await getAccount(provider.connection, ownerUsdc)).amount).toBe(
      amount,
    );
    expect(
      (
        await getAccount(
          provider.connection,
          ownerPrincipal,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(amount);
    expect(
      (
        await getAccount(
          provider.connection,
          ownerEntry,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        )
      ).amount,
    ).toBe(0n);
    expect((await getAccount(provider.connection, prizeVault)).amount).toBe(
      amount,
    );
  });
});
