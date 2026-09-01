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
      amount,
    );

    principalVault = pda("principal-vault");
    prizeVault = pda("prize-vault");

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
      0n,
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
    ).toBe(0n);
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
  });
});
