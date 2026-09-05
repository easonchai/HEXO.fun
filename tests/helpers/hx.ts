import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import idl from "../../target/idl/hex_vault.json" with { type: "json" };
import {
  buildSnapshot,
  ownerOfInterval,
  proofFor,
  type ProofNode,
  type Snapshot,
} from "./merkle.ts";

export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildSnapshot,
  ownerOfInterval,
  proofFor,
};
export type { ProofNode, Snapshot };

const SLOTHASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111",
);
const TEST_CLIENT_SEED = Array.from({ length: 32 }, (_, i) => i);

/** Every test file needs >5s: epoch windows are real wall-clock windows. */
export function longTimeouts(): void {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
}

export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
export const PROGRAM_DATA = PublicKey.findProgramAddressSync(
  [PROGRAM_ID.toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
)[0];

export const bn = (value: number | bigint): BN => new BN(value.toString());
export const le8 = (value: number | bigint): Buffer =>
  bn(value).toArrayLike(Buffer, "le", 8);
export const pda = (seed: string, ...extra: Buffer[]): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(seed), ...extra],
    PROGRAM_ID,
  )[0];

export const tileBit = (tile: number): bigint => 1n << BigInt(tile);
export const tilesOf = (...tiles: number[]): bigint =>
  tiles.reduce((mask, tile) => mask | tileBit(tile), 0n);

export interface EpochWindow {
  id: bigint;
  startsAt: number;
  entryCutoffAt: number;
  endsAt: number;
  prizeSnapshotAt: number;
  claimDeadline: number;
}

/** Window for epochs that must still accept deposits for a while. */
export const longWindow = (id: bigint, now: number): EpochWindow => ({
  id,
  startsAt: now - 20,
  entryCutoffAt: now + 3_000,
  endsAt: now + 6_000,
  prizeSnapshotAt: now + 6_000,
  claimDeadline: now + 9_000,
});

/** Compact window: deposits for ~10s, snapshot at +15s, claims die at +30s. */
export const shortWindow = (id: bigint, now: number): EpochWindow => ({
  id,
  startsAt: now - 5,
  entryCutoffAt: now + 10,
  endsAt: now + 15,
  prizeSnapshotAt: now + 15,
  claimDeadline: now + 30,
});

export const timingArgs = (w: EpochWindow) => ({
  id: bn(w.id),
  startsAt: bn(w.startsAt),
  entryCutoffAt: bn(w.entryCutoffAt),
  endsAt: bn(w.endsAt),
  prizeSnapshotAt: bn(w.prizeSnapshotAt),
  claimDeadline: bn(w.claimDeadline),
});

/** One atomic unit of the mock USDC used by every pool in the suite. */
export const AMT = 1_000_000n;

export interface PoolOptions {
  minDeposit: bigint;
  maxStakePerTile: bigint;
  maxRoundBonusEntries: bigint;
  minEpochSeconds: number;
  maxEpochSeconds: number;
  roundCloseBufferSeconds: number;
}

const DEFAULT_POOL: PoolOptions = {
  minDeposit: 1n,
  maxStakePerTile: AMT,
  maxRoundBonusEntries: 5n * AMT,
  minEpochSeconds: 5,
  maxEpochSeconds: 60 * 60 * 24 * 35,
  roundCloseBufferSeconds: 0,
};

/** One isolated pool instance: its own receipt mints and three vaults. */
export class Pool {
  readonly poolId: bigint;
  readonly address: PublicKey;
  readonly principalMint: PublicKey;
  readonly entryMint: PublicKey;
  readonly principalVault: PublicKey;
  readonly prizeVault: PublicKey;
  readonly jackpotVault: PublicKey;
  readonly options: PoolOptions;
  /** Newest epoch created on this pool; used as the default epoch argument. */
  epochId: bigint = 0n;

  constructor(
    private readonly hv: HexVault,
    poolId: bigint,
    keys: {
      principalMint: PublicKey;
      entryMint: PublicKey;
      principalVault: PublicKey;
      prizeVault: PublicKey;
      jackpotVault: PublicKey;
    },
    options: PoolOptions,
  ) {
    this.poolId = poolId;
    this.address = pda("pool", le8(poolId));
    this.principalMint = keys.principalMint;
    this.entryMint = keys.entryMint;
    this.principalVault = keys.principalVault;
    this.prizeVault = keys.prizeVault;
    this.jackpotVault = keys.jackpotVault;
    this.options = options;
  }

  get program(): any {
    return this.hv.program;
  }

  epoch(id: bigint = this.epochId): PublicKey {
    return pda("epoch", this.address.toBuffer(), le8(id));
  }

  round(epochId: bigint, roundId: bigint): PublicKey {
    return pda("round", this.address.toBuffer(), le8(epochId), le8(roundId));
  }

  roundOf(roundId: bigint): PublicKey {
    return this.round(this.epochId, roundId);
  }

  position(
    roundId: bigint,
    owner: PublicKey,
    epochId = this.epochId,
  ): PublicKey {
    return pda(
      "position",
      this.address.toBuffer(),
      this.round(epochId, roundId).toBuffer(),
      owner.toBuffer(),
    );
  }

  player(owner: PublicKey): PublicKey {
    return pda("player", this.address.toBuffer(), owner.toBuffer());
  }

  request(kind: number, subject: PublicKey): PublicKey {
    return pda(
      "randomness",
      this.address.toBuffer(),
      subject.toBuffer(),
      Buffer.from([kind]),
    );
  }

  principalAta(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.principalMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  entryAta(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.entryMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  receiptBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    return this.hv.tokenBalance(
      getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID),
    );
  }

  principalBalance(owner: PublicKey): Promise<bigint> {
    return this.receiptBalance(this.principalMint, owner);
  }

  entryBalance(owner: PublicKey): Promise<bigint> {
    return this.receiptBalance(this.entryMint, owner);
  }

  vaultBalance(vault: PublicKey): Promise<bigint> {
    return this.hv.tokenBalance(vault);
  }

  acceptedBalance(owner: PublicKey): Promise<bigint> {
    return this.hv.tokenBalance(
      getAssociatedTokenAddressSync(this.hv.usdc, owner),
    );
  }

  poolAccount(): Promise<any> {
    return this.program.account.pool.fetch(this.address);
  }

  epochAccount(id: bigint = this.epochId): Promise<any> {
    return this.program.account.epoch.fetch(this.epoch(id));
  }

  roundAccount(roundId: bigint, epochId: bigint = this.epochId): Promise<any> {
    return this.program.account.round.fetch(this.round(epochId, roundId));
  }

  positionAccount(roundId: bigint, owner: PublicKey): Promise<any> {
    return this.program.account.position.fetch(this.position(roundId, owner));
  }

  playerAccount(owner: PublicKey): Promise<any> {
    return this.program.account.player.fetch(this.player(owner));
  }

  requestAccount(kind: number, subject: PublicKey): Promise<any> {
    return this.program.account.randomnessRequest.fetch(
      this.request(kind, subject),
    );
  }

  depositAccounts(owner: PublicKey, epochId = this.epochId) {
    return {
      owner,
      config: this.hv.config,
      pool: this.address,
      epoch: this.epoch(epochId),
      player: this.player(owner),
      acceptedMint: this.hv.usdc,
      ownerAccepted: getAssociatedTokenAddressSync(this.hv.usdc, owner),
      principalVault: this.principalVault,
      principalMint: this.principalMint,
      entryMint: this.entryMint,
      ownerPrincipal: this.principalAta(owner),
      ownerEntry: this.entryAta(owner),
      acceptedTokenProgram: TOKEN_PROGRAM_ID,
      receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  withdrawAccounts(owner: PublicKey) {
    return {
      owner,
      config: this.hv.config,
      pool: this.address,
      acceptedMint: this.hv.usdc,
      ownerAccepted: getAssociatedTokenAddressSync(this.hv.usdc, owner),
      principalVault: this.principalVault,
      principalMint: this.principalMint,
      entryMint: this.entryMint,
      ownerPrincipal: this.principalAta(owner),
      ownerEntry: this.entryAta(owner),
      acceptedTokenProgram: TOKEN_PROGRAM_ID,
      receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
    };
  }

  async deposit(
    owner: Keypair,
    amount: bigint,
    epochId = this.epochId,
  ): Promise<string> {
    return await this.program.methods
      .deposit(bn(amount))
      .accounts({ ...this.depositAccounts(owner.publicKey, epochId) })
      .signers([owner])
      .rpc();
  }

  async refresh(owner: Keypair, epochId = this.epochId): Promise<string> {
    const accounts = this.depositAccounts(owner.publicKey, epochId);
    return await this.program.methods
      .refreshEntries()
      .accounts({
        owner: accounts.owner,
        config: accounts.config,
        pool: accounts.pool,
        epoch: accounts.epoch,
        player: accounts.player,
        principalMint: accounts.principalMint,
        entryMint: accounts.entryMint,
        ownerPrincipal: accounts.ownerPrincipal,
        ownerEntry: accounts.ownerEntry,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  async withdraw(owner: Keypair, amount: bigint): Promise<string> {
    return await this.program.methods
      .withdraw(bn(amount))
      .accounts({ ...this.withdrawAccounts(owner.publicKey) })
      .signers([owner])
      .rpc();
  }

  async fundPrize(owner: Keypair, amount: bigint): Promise<string> {
    return await this.program.methods
      .fundPrize(bn(amount))
      .accounts({
        funder: owner.publicKey,
        config: this.hv.config,
        pool: this.address,
        acceptedMint: this.hv.usdc,
        funderAccepted: getAssociatedTokenAddressSync(
          this.hv.usdc,
          owner.publicKey,
        ),
        prizeVault: this.prizeVault,
        acceptedTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  async fundJackpot(owner: Keypair, amount: bigint): Promise<string> {
    return await this.program.methods
      .fundJackpot(bn(amount))
      .accounts({
        funder: owner.publicKey,
        config: this.hv.config,
        pool: this.address,
        acceptedMint: this.hv.usdc,
        funderAccepted: getAssociatedTokenAddressSync(
          this.hv.usdc,
          owner.publicKey,
        ),
        jackpotVault: this.jackpotVault,
        acceptedTokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  async createFirstEpoch(window: EpochWindow): Promise<string> {
    const sig = await this.program.methods
      .createFirstEpoch({ ...timingArgs(window) })
      .accounts({
        authority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(window.id),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    this.epochId = window.id;
    return sig;
  }

  async beginNextEpoch(priorId: bigint, window: EpochWindow): Promise<string> {
    const sig = await this.program.methods
      .beginNextEpoch({ ...timingArgs(window) })
      .accounts({
        authority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        priorEpoch: this.epoch(priorId),
        epoch: this.epoch(window.id),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    this.epochId = window.id;
    return sig;
  }

  async setPause(guardian: Keypair, paused: boolean): Promise<string> {
    return await this.program.methods
      .setPause(paused)
      .accounts({
        guardian: guardian.publicKey,
        config: this.hv.config,
        pool: this.address,
      })
      .signers([guardian])
      .rpc();
  }

  async createRound(
    roundId: bigint,
    startsAt: number,
    endsAt: number,
    bonusEntries: bigint,
    epochId = this.epochId,
  ): Promise<string> {
    return await this.program.methods
      .createRound(bn(roundId), bn(startsAt), bn(endsAt), bn(bonusEntries))
      .accounts({
        authority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(epochId),
        round: this.round(epochId, roundId),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async buy(
    owner: Keypair,
    roundId: bigint,
    tiles: bigint,
    stakePerTile: bigint,
    epochId = this.epochId,
  ): Promise<string> {
    return await this.program.methods
      .buyPosition(bn(tiles), bn(stakePerTile))
      .accounts({
        owner: owner.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(epochId),
        player: this.player(owner.publicKey),
        round: this.round(epochId, roundId),
        position: this.position(roundId, owner.publicKey, epochId),
        entryMint: this.entryMint,
        ownerEntry: this.entryAta(owner.publicKey),
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  }

  async requestRoundRandomness(
    roundId: bigint,
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.roundOf(roundId);
    return await this.program.methods
      .requestRoundRandomness(TEST_CLIENT_SEED)
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        round: subject,
        request: this.request(0, subject),
        recentSlothaves: SLOTHASHES_SYSVAR,
        systemProgram: SystemProgram.programId,
      })
      .signers([requester])
      .rpc();
  }

  async fulfillRound(roundId: bigint, sample: bigint): Promise<string> {
    const subject = this.roundOf(roundId);
    return await this.program.methods
      .fulfillRoundWithMock(bn(sample))
      .accounts({
        mockRandomnessAuthority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        round: subject,
        request: this.request(0, subject),
      })
      .rpc();
  }

  /** VRF settle with explicit ORAO accounts (tests pass fakes to assert gating). */
  async fulfillRoundWithVrf(
    roundId: bigint,
    oraoNetworkState: PublicKey,
    oraoRequest: PublicKey,
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.roundOf(roundId);
    return await this.program.methods
      .fulfillRoundWithVrf()
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        round: subject,
        request: this.request(0, subject),
        oraoNetworkState,
        oraoRequest,
      })
      .signers([requester])
      .rpc();
  }

  async claimRoundReward(owner: Keypair, roundId: bigint): Promise<string> {
    return await this.program.methods
      .claimRoundReward()
      .accounts({
        owner: owner.publicKey,
        config: this.hv.config,
        pool: this.address,
        round: this.roundOf(roundId),
        position: this.position(roundId, owner.publicKey),
        entryMint: this.entryMint,
        ownerEntry: this.entryAta(owner.publicKey),
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  /** Snapshot of the live entry (ET) balances, which is the prize cohort. */
  async snapshotFromBalances(owners: PublicKey[]): Promise<Snapshot> {
    const leaves = [];
    for (const owner of owners) {
      const weight = await this.entryBalance(owner);
      if (weight > 0n) leaves.push({ owner, weight });
    }
    return buildSnapshot(leaves);
  }

  async commitPrizeSnapshot(
    snapshot: Snapshot,
    prizeAmount: bigint,
    snapshotAuthority: Keypair = this.hv.payer,
  ): Promise<string> {
    return await this.program.methods
      .commitPrizeSnapshot(snapshot.root, bn(snapshot.total), bn(prizeAmount))
      .accounts({
        snapshotAuthority: snapshotAuthority.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(),
        prizeVault: this.prizeVault,
      })
      .signers([snapshotAuthority])
      .rpc();
  }

  async commitJackpot(
    snapshotAuthority: Keypair = this.hv.payer,
  ): Promise<string> {
    return await this.program.methods
      .commitJackpot()
      .accounts({
        snapshotAuthority: snapshotAuthority.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(),
        jackpotVault: this.jackpotVault,
      })
      .signers([snapshotAuthority])
      .rpc();
  }

  async requestPrizeRandomness(
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .requestPrizeRandomness(TEST_CLIENT_SEED)
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(1, subject),
        recentSlothaves: SLOTHASHES_SYSVAR,
        systemProgram: SystemProgram.programId,
      })
      .signers([requester])
      .rpc();
  }

  async fulfillPrize(sample: bigint): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .fulfillPrizeWithMock(bn(sample))
      .accounts({
        mockRandomnessAuthority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(1, subject),
      })
      .rpc();
  }

  /** VRF settle with explicit ORAO accounts (tests pass fakes to assert gating). */
  async fulfillPrizeWithVrf(
    oraoNetworkState: PublicKey,
    oraoRequest: PublicKey,
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .fulfillPrizeWithVrf()
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(1, subject),
        oraoNetworkState,
        oraoRequest,
      })
      .signers([requester])
      .rpc();
  }

  async requestJackpotRandomness(
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .requestJackpotRandomness(TEST_CLIENT_SEED)
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(2, subject),
        recentSlothaves: SLOTHASHES_SYSVAR,
        systemProgram: SystemProgram.programId,
      })
      .signers([requester])
      .rpc();
  }

  async fulfillJackpot(sample: bigint): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .fulfillJackpotWithMock(bn(sample))
      .accounts({
        mockRandomnessAuthority: this.hv.authority,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(2, subject),
      })
      .rpc();
  }

  /** VRF settle with explicit ORAO accounts (tests pass fakes to assert gating). */
  async fulfillJackpotWithVrf(
    oraoNetworkState: PublicKey,
    oraoRequest: PublicKey,
    requester: Keypair = this.hv.payer,
  ): Promise<string> {
    const subject = this.epoch();
    return await this.program.methods
      .fulfillJackpotWithVrf()
      .accounts({
        requester: requester.publicKey,
        config: this.hv.config,
        pool: this.address,
        epoch: subject,
        request: this.request(2, subject),
        oraoNetworkState,
        oraoRequest,
      })
      .signers([requester])
      .rpc();
  }

  claimAccounts(winner: PublicKey, vault: "prize" | "jackpot") {
    return {
      config: this.hv.config,
      pool: this.address,
      epoch: this.epoch(),
      winner,
      acceptedMint: this.hv.usdc,
      winnerAccepted: getAssociatedTokenAddressSync(this.hv.usdc, winner),
      [vault === "prize" ? "prizeVault" : "jackpotVault"]:
        vault === "prize" ? this.prizeVault : this.jackpotVault,
      acceptedTokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  async claimPrize(
    winner: PublicKey,
    weight: bigint,
    proof: ProofNode[],
  ): Promise<string> {
    return await this.program.methods
      .claimPrize(bn(weight), encodeProof(proof))
      .accounts({ ...this.claimAccounts(winner, "prize") })
      .rpc();
  }

  async claimJackpot(
    winner: PublicKey,
    weight: bigint,
    proof: ProofNode[],
  ): Promise<string> {
    return await this.program.methods
      .claimJackpot(bn(weight), encodeProof(proof))
      .accounts({ ...this.claimAccounts(winner, "jackpot") })
      .rpc();
  }

  async expirePrize(): Promise<string> {
    return await this.program.methods
      .expireUnclaimedPrize()
      .accounts({
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(),
      })
      .rpc();
  }

  async expireJackpot(): Promise<string> {
    return await this.program.methods
      .expireJackpot()
      .accounts({
        config: this.hv.config,
        pool: this.address,
        epoch: this.epoch(),
      })
      .rpc();
  }
}

export class HexVault {
  readonly provider: AnchorProvider;
  readonly program: any;
  readonly connection: Connection;
  readonly payer: Keypair;
  readonly authority: PublicKey;
  readonly config: PublicKey;
  /** Classic-SPL mock USDC mint, authority = provider wallet. */
  usdc: PublicKey = PublicKey.default;
  private nextPoolId: bigint;

  private constructor(
    provider: AnchorProvider,
    payer: Keypair,
    usdc: PublicKey,
    nextPoolId: bigint,
  ) {
    this.provider = provider;
    this.connection = provider.connection;
    this.program = new Program(idl as any, provider) as any;
    this.payer = payer;
    this.authority = payer.publicKey;
    this.config = pda("config");
    this.usdc = usdc;
    this.nextPoolId = nextPoolId;
  }

  /**
   * Provider + accepted test asset. `initialize: false` leaves the protocol
   * uninitialized so a suite can probe the upgrade-authority guard first;
   * every other suite waits for that suite (or falls back to initializing).
   */
  static async create(
    options: { initialize?: boolean } = {},
  ): Promise<HexVault> {
    const provider = await makeProvider();
    const payer = provider.wallet.payer as Keypair;
    if (!payer) throw new Error("provider wallet must expose a keypair");
    const hv = new HexVault(provider, payer, PublicKey.default, randomBase());
    hv.usdc = await createMint(hv.connection, payer, hv.authority, null, 6);
    // every suite sponsors prize/jackpot funding from the provider wallet
    await hv.fundUsdc(hv.payer, AMT * 200n);
    if (options.initialize === false) return hv;
    await hv.awaitProtocolReady();
    return hv;
  }

  /** Gives the suite that tests the initialize guard a head start. */
  private async awaitProtocolReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.program.account.protocolConfig.fetchNullable(this.config))
        return;
      await sleep(250);
    }
    await this.initializeProtocol();
  }

  /**
   * Global protocol init. Requires the program upgrade authority, so it runs
   * once per validator; parallel vitest files serialise through a lock file
   * keyed by genesis hash.
   */
  async initializeProtocol(): Promise<void> {
    const existing = await this.program.account.protocolConfig.fetchNullable(
      this.config,
    );
    if (existing) return;

    const genesis = await this.connection.getGenesisHash();
    const lockPath = path.join(
      os.tmpdir(),
      `hexvault-init-${genesis.replace(/[^A-Za-z0-9]/g, "")}.lock`,
    );
    for (;;) {
      let locked: number;
      try {
        locked = fs.openSync(lockPath, "wx");
      } catch {
        await sleep(300);
        if (
          await this.program.account.protocolConfig.fetchNullable(this.config)
        )
          return;
        continue;
      }
      try {
        await this.program.methods
          .initialize({
            guardian: this.authority,
            snapshotAuthority: this.authority,
            mockRandomnessAuthority: this.authority,
            // Localnet runs mock-only; the VRF path is exercised on devnet.
            vrfRandomnessState: PublicKey.default,
          })
          .accounts({
            authority: this.authority,
            config: this.config,
            program: PROGRAM_ID,
            programData: PROGRAM_DATA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } finally {
        fs.closeSync(locked);
        fs.rmSync(lockPath, { force: true });
      }
      return;
    }
  }

  /** Rejects an initialize attempt from any wallet that is not the upgrade authority. */
  async expectUnauthorizedInitialize(attacker: Keypair): Promise<unknown> {
    return await this.program.methods
      .initialize({
        guardian: attacker.publicKey,
        snapshotAuthority: attacker.publicKey,
        mockRandomnessAuthority: attacker.publicKey,
        vrfRandomnessState: PublicKey.default,
      })
      .accounts({
        authority: attacker.publicKey,
        config: this.config,
        program: PROGRAM_ID,
        programData: PROGRAM_DATA,
        systemProgram: SystemProgram.programId,
      })
      .signers([attacker])
      .rpc();
  }

  async createPool(options: Partial<PoolOptions> = {}): Promise<Pool> {
    const resolved = { ...DEFAULT_POOL, ...options };
    const poolId = this.nextPoolId++;
    const principalMint = Keypair.generate();
    const entryMint = Keypair.generate();
    const pool = pda("pool", le8(poolId));
    const keys = {
      principalMint: principalMint.publicKey,
      entryMint: entryMint.publicKey,
      principalVault: pda("principal-vault", pool.toBuffer()),
      prizeVault: pda("prize-vault", pool.toBuffer()),
      jackpotVault: pda("jackpot-vault", pool.toBuffer()),
    };

    await this.program.methods
      .createPool({
        poolId: bn(poolId),
        minDeposit: bn(resolved.minDeposit),
        maxStakePerTile: bn(resolved.maxStakePerTile),
        maxRoundBonusEntries: bn(resolved.maxRoundBonusEntries),
        minEpochSeconds: bn(resolved.minEpochSeconds),
        maxEpochSeconds: bn(resolved.maxEpochSeconds),
        roundCloseBufferSeconds: bn(resolved.roundCloseBufferSeconds),
      })
      .accounts({
        authority: this.authority,
        config: this.config,
        pool,
        acceptedMint: this.usdc,
        acceptedTokenProgram: TOKEN_PROGRAM_ID,
        principalMint: keys.principalMint,
        entryMint: keys.entryMint,
        principalVault: keys.principalVault,
        prizeVault: keys.prizeVault,
        jackpotVault: keys.jackpotVault,
        receiptTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([principalMint, entryMint])
      .rpc();

    return new Pool(this, poolId, keys, resolved);
  }

  /** Fresh wallet with SOL (and optionally mock USDC) for multi-player tests. */
  async wallet(
    usdc = 0n,
    sol = 2n * BigInt(LAMPORTS_PER_SOL),
  ): Promise<Keypair> {
    const owner = Keypair.generate();
    await this.airdrop(owner.publicKey, sol);
    if (usdc > 0n) await this.fundUsdc(owner, usdc);
    return owner;
  }

  async airdrop(to: PublicKey, lamports: bigint): Promise<void> {
    const signature = await this.connection.requestAirdrop(
      to,
      Number(lamports),
    );
    await this.confirm(signature);
  }

  /** Creates the classic-SPL USDC ATA for `owner` and tops it up. */
  async fundUsdc(owner: Keypair, amount: bigint): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(this.usdc, owner.publicKey);
    if (!(await this.connection.getAccountInfo(ata))) {
      await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            this.authority,
            ata,
            owner.publicKey,
            this.usdc,
          ),
        ),
        [this.payer],
      );
    }
    if (amount > 0n) {
      await mintTo(
        this.connection,
        this.payer,
        this.usdc,
        ata,
        this.authority,
        amount,
      );
    }
    return ata;
  }

  async tokenBalance(account: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(account);
    if (!info) return 0n;
    return await (
      await getAccount(this.connection, account, "confirmed", info.owner)
    ).amount;
  }

  async confirm(signature: string): Promise<void> {
    await this.connection.confirmTransaction(signature, "confirmed");
  }

  async events(signature: string): Promise<any[]> {
    let last = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        const events = [];
        for (const line of tx.meta.logMessages) {
          if (!line.startsWith("Program data: ")) continue;
          const decoded = this.program.coder.events.decode(
            line.slice("Program data: ".length),
          );
          if (decoded) events.push(decoded);
        }
        return events;
      }
      last = tx;
      await sleep(300);
    }
    throw new Error(
      `no transaction metadata for ${signature}: ${String(last)}`,
    );
  }

  /** On-chain Clock time, falling back to host time if the slot is too fresh. */
  async chainNow(): Promise<number> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const slot = await this.connection.getSlot("confirmed");
      const time = await this.connection.getBlockTime(
        Math.max(slot - attempt, 0),
      );
      if (typeof time === "number") return time;
    }
    return Math.floor(Date.now() / 1000);
  }

  async waitUntil(unix: number): Promise<void> {
    for (;;) {
      const now = await this.chainNow();
      if (now >= unix) return;
      await sleep(Math.min(Math.max((unix - now) * 250, 250), 2_000));
    }
  }
}

export const ORAO_VRF_PROGRAM_ID = new PublicKey(
  "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y",
);
const ORAO_REQUEST_SEED = Buffer.from("orao-vrf-randomness-request");

/**
 * A fresh account genuinely owned by the ORAO VRF program id, with no other
 * relationship to the protocol's pinned `config.vrf_randomness_state`.
 * Stands in for "any ORAO-owned account" in network-state pin tests: no real
 * ORAO program runs on localnet, but `SystemProgram.createAccount` can set
 * an arbitrary owner directly, which is all the `owner` constraint checks.
 */
export async function fakeOraoAccount(hv: HexVault): Promise<PublicKey> {
  const account = Keypair.generate();
  const lamports = await hv.connection.getMinimumBalanceForRentExemption(0);
  await sendAndConfirmTransaction(
    hv.connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: hv.authority,
        newAccountPubkey: account.publicKey,
        lamports,
        space: 0,
        programId: ORAO_VRF_PROGRAM_ID,
      }),
    ),
    [hv.payer, account],
  );
  return account.publicKey;
}

/** Mirrors `crate::vrf::orao_request_address`: the ORAO request PDA for one (network state, seed) pair. */
export const oraoRequestAddress = (
  networkState: PublicKey,
  seed: Uint8Array | number[],
): PublicKey =>
  PublicKey.findProgramAddressSync(
    [ORAO_REQUEST_SEED, networkState.toBuffer(), Buffer.from(seed)],
    ORAO_VRF_PROGRAM_ID,
  )[0];

/** Anchor's borsh coder wants BN sums; the merkle helper speaks plain bigints. */
const encodeProof = (proof: ProofNode[]): unknown[] =>
  proof.map((node) => ({
    siblingHash: node.siblingHash,
    siblingSum: bn(node.siblingSum),
    siblingIsLeft: node.siblingIsLeft,
  }));

const makeProvider = async (): Promise<AnchorProvider> => {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletFile =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletFile, "utf8")) as number[]),
  );
  const connection = new Connection(url, { commitment: "confirmed" });
  return new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
  });
};

const randomBase = (): bigint =>
  BigInt(Math.floor(Math.random() * 900_000)) * 1_000n;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Anchor decodes event names to camelCase; compare case-insensitively. */
export const findEvent = (events: any[], name: string): any =>
  events.find(
    (event) => String(event?.name ?? "").toLowerCase() === name.toLowerCase(),
  );
