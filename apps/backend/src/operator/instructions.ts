// One builder per step of spec §3.4. Every account is passed explicitly
// (`accountsPartial`) so building an instruction never costs an RPC round
// trip, and so the unit tests can build the real instructions offline.
import { BN, type Idl, type Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  epochAddress,
  jackpotVaultAddress,
  playerAddress,
  roundAddress,
} from "../chain/pda";
import type { EpochState, PoolState, RoundState } from "./chain-state";
import {
  ORAO_VRF_PROGRAM_ID,
  ORAO_VRF_TREASURY,
  randomnessAddress,
  vrfSeed,
} from "./vrf";

const bn = (value: bigint): BN => new BN(value.toString());

/** The two calls this file makes on an Anchor methods builder. */
interface MethodBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): {
    instruction(): Promise<TransactionInstruction>;
  };
}

type MethodFactory = (...args: unknown[]) => MethodBuilder;

export class OperatorInstructions {
  constructor(
    private readonly program: Program<Idl>,
    private readonly programId: PublicKey,
    private readonly authority: PublicKey,
    /**
     * True when the deployed program is a `test-vrf` build, which puts the
     * randomness account at a PDA of this program instead of ORAO's. Read off
     * the IDL, the only thing that tracks which build is out there.
     */
    private readonly testVrf: boolean,
  ) {}

  randomnessFor(seed: Uint8Array): PublicKey {
    return randomnessAddress(this.programId, seed, this.testVrf);
  }

  /**
   * `Program<Idl>` carries no generated instruction types, so its methods
   * namespace is keyed by plain strings and every entry reads as optional.
   * Looking one up here turns a stale IDL into one clear error instead of a
   * "cannot invoke undefined" at the call site.
   */
  private method(name: string, ...args: unknown[]): MethodBuilder {
    // SAFETY: the shape is checked structurally by MethodBuilder; only the
    // name is unknown to the compiler, and it is checked right below.
    const factory = (this.program.methods as Record<string, MethodFactory | undefined>)[name];
    if (!factory) {
      throw new Error(`instruction ${name} is missing from the IDL; re-run sync-idl`);
    }
    return factory(...args);
  }

  private epoch(pool: PoolState, epochId: bigint): PublicKey {
    return epochAddress(this.programId, pool.address, epochId);
  }

  private round(pool: PoolState, roundId: bigint): PublicKey {
    return roundAddress(this.programId, pool.address, roundId);
  }

  private player(pool: PoolState, owner: PublicKey): PublicKey {
    return playerAddress(this.programId, pool.address, owner);
  }

  async beginEpoch(pool: PoolState): Promise<TransactionInstruction[]> {
    // `current_epoch` does not exist before the first epoch; the program skips
    // it in that case, but the address still has to be supplied.
    return [
      await this.method("beginEpoch")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          currentEpoch: this.epoch(pool, pool.currentEpochId),
          newEpoch: this.epoch(pool, pool.currentEpochId + 1n),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  async register(
    pool: PoolState,
    epochId: bigint,
    owners: readonly PublicKey[],
  ): Promise<TransactionInstruction[]> {
    return Promise.all(
      owners.map((owner) =>
        this.method("register")
          .accountsPartial({
            pool: pool.address,
            epoch: this.epoch(pool, epochId),
            player: this.player(pool, owner),
          })
          .instruction(),
      ),
    );
  }

  /**
   * Step 2's tail: top the authority's own hexUSDC up when it is short (it is
   * the mint authority), move the simulated yield into the jackpot vault, and
   * close registration, all in one transaction so a partial funding can never
   * be what the epoch draws on.
   */
  async fundAndClose(
    pool: PoolState,
    epochId: bigint,
    amount: bigint,
    shortfall: bigint,
  ): Promise<TransactionInstruction[]> {
    const source = getAssociatedTokenAddressSync(pool.acceptedMint, this.authority);
    const mintTo =
      shortfall > 0n
        ? [
            createMintToInstruction(
              pool.acceptedMint,
              source,
              this.authority,
              shortfall,
            ),
          ]
        : [];

    const fund = await this.method("fundJackpot", bn(amount))
      .accountsPartial({
        sourceAuthority: this.authority,
        pool: pool.address,
        acceptedMint: pool.acceptedMint,
        source,
        jackpotVault: jackpotVaultAddress(this.programId, pool.address),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const close = await this.method("closeRegistration")
      .accountsPartial({
        authority: this.authority,
        pool: pool.address,
        epoch: this.epoch(pool, epochId),
        jackpotVault: jackpotVaultAddress(this.programId, pool.address),
        // The seed is computed inside the same instruction, so it has to be
        // derived here rather than read back off the Epoch.
        randomness: this.randomnessFor(vrfSeed("epoch", pool.address, epochId)),
        vrfNetworkState: pool.vrfNetworkState,
        vrfTreasury: ORAO_VRF_TREASURY,
        vrfProgram: ORAO_VRF_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return [...mintTo, fund, close];
  }

  async draw(pool: PoolState, epoch: EpochState): Promise<TransactionInstruction[]> {
    return [
      await this.method("draw")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          epoch: this.epoch(pool, epoch.epochId),
          randomness: this.randomnessFor(epoch.vrfSeed),
        })
        .instruction(),
    ];
  }

  async rolloverEpoch(pool: PoolState, epochId: bigint): Promise<TransactionInstruction[]> {
    return [
      await this.method("rolloverEpoch")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          epoch: this.epoch(pool, epochId),
        })
        .instruction(),
    ];
  }

  /** The winner's token account may not exist yet, so create it idempotently. */
  async payout(
    pool: PoolState,
    epochId: bigint,
    winner: PublicKey,
  ): Promise<TransactionInstruction[]> {
    const winnerToken = getAssociatedTokenAddressSync(pool.acceptedMint, winner);
    return [
      createAssociatedTokenAccountIdempotentInstruction(
        this.authority,
        winnerToken,
        winner,
        pool.acceptedMint,
      ),
      await this.method("payout")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          acceptedMint: pool.acceptedMint,
          epoch: this.epoch(pool, epochId),
          winner: this.player(pool, winner),
          jackpotVault: jackpotVaultAddress(this.programId, pool.address),
          winnerToken,
          treasury: pool.treasury,
          buybackReserve: pool.buybackReserve,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  async requestRoundRandomness(
    pool: PoolState,
    round: RoundState,
  ): Promise<TransactionInstruction[]> {
    return [
      await this.method("requestRoundRandomness")
        .accountsPartial({
          payer: this.authority,
          pool: pool.address,
          round: this.round(pool, round.roundId),
          randomness: this.randomnessFor(round.vrfSeed),
          vrfNetworkState: pool.vrfNetworkState,
          vrfTreasury: ORAO_VRF_TREASURY,
          vrfProgram: ORAO_VRF_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  async settleRound(pool: PoolState, round: RoundState): Promise<TransactionInstruction[]> {
    return [
      await this.method("settleRound")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          round: this.round(pool, round.roundId),
          randomness: this.randomnessFor(round.vrfSeed),
          house: pool.house,
        })
        .instruction(),
    ];
  }

  async voidRound(pool: PoolState, roundId: bigint): Promise<TransactionInstruction[]> {
    return [
      await this.method("voidRound")
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          round: this.round(pool, roundId),
        })
        .instruction(),
    ];
  }

  async settlePositions(
    pool: PoolState,
    roundId: bigint,
    positions: readonly { address: string; owner: string }[],
  ): Promise<TransactionInstruction[]> {
    const round = this.round(pool, roundId);
    return Promise.all(
      positions.map((position) => {
        const owner = new PublicKey(position.owner);
        return this.method("settlePosition")
          .accountsPartial({
            pool: pool.address,
            round,
            player: this.player(pool, owner),
            owner,
            position: new PublicKey(position.address),
          })
          .instruction();
      }),
    );
  }

  async createRound(
    pool: PoolState,
    startsAt: bigint,
    endsAt: bigint,
  ): Promise<TransactionInstruction[]> {
    return [
      await this.method("createRound", bn(startsAt), bn(endsAt))
        .accountsPartial({
          authority: this.authority,
          pool: pool.address,
          currentEpoch: this.epoch(pool, pool.currentEpochId),
          round: this.round(pool, pool.nextRoundId),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }
}
