import { Keypair, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  HexVault,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  bn,
  findEvent,
  le8,
  longTimeouts,
  longWindow,
  pda,
  type Pool,
} from "./helpers/hx.ts";

const AMT = 1_000_000n;

describe("custody: initialize, pool creation, deposits, segregated funding, matched withdrawals", () => {
  longTimeouts();

  let hv: HexVault;
  let pool: Pool;
  let attacker: Keypair;
  let attackerRejection: Error | undefined;
  let configPreExisted: boolean;
  let ownerUsdc: bigint;
  let now: number;

  beforeAll(async () => {
    // Uninitialized on purpose where possible: the upgrade-authority guard only
    // bites before any legitimate initialize has landed.
    hv = await HexVault.create({ initialize: false });
    configPreExisted =
      (await hv.program.account.protocolConfig.fetchNullable(hv.config)) !==
      null;
    attacker = await hv.wallet(0n, 500_000_000n);
    attackerRejection = await hv.expectUnauthorizedInitialize(attacker).then(
      () => undefined,
      (error: Error) => error,
    );
    await hv.initializeProtocol();

    pool = await hv.createPool();
    now = await hv.chainNow();
    await pool.createFirstEpoch(longWindow(1n, now));
    await hv.fundUsdc(hv.payer, AMT * 20n);
    ownerUsdc = await pool.acceptedBalance(hv.authority);
  });

  it("rejects initialize from a wallet that is not the program upgrade authority", async () => {
    if (configPreExisted) {
      // warm validator: the config account guard rejects the attacker first
      expect(attackerRejection?.message).toMatch(
        /UnauthorizedAuthority|already in use/i,
      );
    } else {
      expect(attackerRejection?.message).toContain("UnauthorizedAuthority");
    }
    // either way the attacker never seized the config
    const stored = await hv.program.account.protocolConfig.fetch(hv.config);
    expect(stored.authority.toBase58()).toBe(hv.authority.toBase58());
    expect(stored.guardian.toBase58()).toBe(hv.authority.toBase58());
  });

  it("rejects pool creation by any signer other than the protocol authority", async () => {
    const poolId =
      1_000_000_000n + BigInt(Math.floor(Math.random() * 1_000_000));
    const poolAddress = pda("pool", le8(poolId));
    const principalMint = Keypair.generate();
    const entryMint = Keypair.generate();

    await expect(
      hv.program.methods
        .createPool({
          poolId: bn(poolId),
          minDeposit: bn(1n),
          maxStakePerTile: bn(AMT),
          maxRoundBonusEntries: bn(AMT),
          minEpochSeconds: bn(5),
          maxEpochSeconds: bn(60 * 60 * 24 * 35),
          roundCloseBufferSeconds: bn(0),
        })
        .accounts({
          authority: attacker.publicKey,
          config: hv.config,
          pool: poolAddress,
          acceptedMint: hv.usdc,
          acceptedTokenProgram: TOKEN_PROGRAM_ID,
          principalMint: principalMint.publicKey,
          entryMint: entryMint.publicKey,
          principalVault: pda("principal-vault", poolAddress.toBuffer()),
          prizeVault: pda("prize-vault", poolAddress.toBuffer()),
          jackpotVault: pda("jackpot-vault", poolAddress.toBuffer()),
          receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker, principalMint, entryMint])
        .rpc(),
    ).rejects.toThrow("UnauthorizedAuthority");

    expect(await hv.connection.getAccountInfo(poolAddress)).toBeNull();
  });

  it("mints matched PT and ET only after the accepted asset reaches the principal vault", async () => {
    await pool.deposit(hv.payer, AMT);

    const events = await hv.events(await pool.deposit(hv.payer, AMT * 2n));
    const recorded = findEvent(events, "DepositRecorded")?.data;
    expect(recorded?.pool?.toBase58()).toBe(pool.address.toBase58());
    expect(recorded?.owner?.toBase58()).toBe(hv.authority.toBase58());
    expect(recorded?.amount?.toNumber()).toBe(Number(AMT * 2n));
    expect(recorded?.epochId?.toNumber()).toBe(1);

    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 3n);
    expect(await pool.acceptedBalance(hv.authority)).toBe(ownerUsdc - AMT * 3n);
    expect(await pool.principalBalance(hv.authority)).toBe(AMT * 3n);
    expect(await pool.entryBalance(hv.authority)).toBe(AMT * 3n);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(0n);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(0n);
  });

  it("keeps sponsor prize funding out of the principal vault", async () => {
    await pool.fundPrize(hv.payer, AMT * 2n);

    expect(await pool.vaultBalance(pool.prizeVault)).toBe(AMT * 2n);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 3n);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(0n);
  });

  it("keeps jackpot funding out of both the principal and prize vaults", async () => {
    await pool.fundJackpot(hv.payer, AMT * 3n);

    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(AMT * 3n);
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 3n);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(AMT * 2n);
  });

  it("blocks withdrawal once entry tokens are committed to a position", async () => {
    await pool.createRound(1n, now - 10, now + 600, 0n);
    await pool.buy(hv.payer, 1n, 1n, AMT);

    expect(await pool.entryBalance(hv.authority)).toBe(AMT * 2n);
    await expect(pool.withdraw(hv.payer, AMT * 3n)).rejects.toThrow(
      "InsufficientMatchedBalance",
    );

    // No state changed: the principal and both receipt balances are intact.
    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT * 3n);
    expect(await pool.principalBalance(hv.authority)).toBe(AMT * 3n);
    expect(await pool.entryBalance(hv.authority)).toBe(AMT * 2n);
  });

  it("burns matched PT and ET and returns exactly that principal", async () => {
    const usdcBefore = await pool.acceptedBalance(hv.authority);
    const events = await hv.events(await pool.withdraw(hv.payer, AMT * 2n));
    const recorded = findEvent(events, "WithdrawalRecorded")?.data;
    expect(recorded?.pool?.toBase58()).toBe(pool.address.toBase58());
    expect(recorded?.amount?.toNumber()).toBe(Number(AMT * 2n));

    expect(await pool.vaultBalance(pool.principalVault)).toBe(AMT);
    expect(await pool.acceptedBalance(hv.authority)).toBe(
      usdcBefore + AMT * 2n,
    );
    expect(await pool.principalBalance(hv.authority)).toBe(AMT);
    expect(await pool.entryBalance(hv.authority)).toBe(0n);
    expect(await pool.vaultBalance(pool.prizeVault)).toBe(AMT * 2n);
    expect(await pool.vaultBalance(pool.jackpotVault)).toBe(AMT * 3n);

    const stored = await pool.poolAccount();
    expect(stored.principalVault.toBase58()).toBe(
      pool.principalVault.toBase58(),
    );
    expect(stored.prizeVault.toBase58()).toBe(pool.prizeVault.toBase58());
    expect(stored.jackpotVault.toBase58()).toBe(pool.jackpotVault.toBase58());
    expect(stored.paused).toBe(false);
    expect(stored.maxStakePerTile.toNumber()).toBe(Number(AMT));
    expect(stored.entryMint.toBase58()).toBe(pool.entryMint.toBase58());
    expect(stored.principalMint.toBase58()).toBe(pool.principalMint.toBase58());
  });

  it("keeps the accepted asset on the classic token program and receipts on Token-2022", async () => {
    for (const mint of [pool.principalMint, pool.entryMint]) {
      expect((await hv.connection.getAccountInfo(mint))?.owner.toBase58()).toBe(
        TOKEN_2022_PROGRAM_ID.toBase58(),
      );
    }
    expect(
      (await hv.connection.getAccountInfo(hv.usdc))?.owner.toBase58(),
    ).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});
