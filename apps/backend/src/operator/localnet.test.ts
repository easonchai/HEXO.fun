// End to end against a solana-test-validator running the `test-vrf` build:
//
//   HEXVAULT_SKIP_BUILD=1 HEXVAULT_RPC_PORT=9299 \
//     sh tests/run-local.sh src/operator/localnet
//
// Skipped everywhere else, so `pnpm test` in this package stays offline. The
// operator drives the whole protocol here; the test only deposits, buys two
// positions, and stands in for the two things the operator does not own: the
// oracle (test_fulfill) and the indexer (Player and Position rows).
import "reflect-metadata";

import { BN } from "@anchor-lang/core";
import {
  createAccount,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import type { ConfigService } from "@nestjs/config";
import bs58 from "bs58";
import { afterAll, describe, expect, it } from "vitest";

import { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import { playerAddress, positionAddress } from "../chain/pda";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  decodeEpoch,
  decodePool,
  decodeRound,
  EPOCH_STATUS,
  ROUND_STATUS,
  type EpochState,
  type PoolState,
} from "./chain-state";
import type { IndexerQueries } from "./indexer-queries";
import { OperatorService } from "./operator.service";
import { randomnessAddress } from "./vrf";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL;

// The operator writes OperatorState and reads Players here. Same database the
// unit tests use; every row this file writes is deleted again below.
process.env.DATABASE_URL =
  process.env.OPERATOR_DATABASE_URL ??
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault_operator";

/** Pinned on the pool at creation; `test-vrf` builds never dereference it. */
const VRF_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

const EPOCH_SECONDS = 40;
const ROUND_SECONDS = 15;
const CLOSE_BUFFER = 5;
const DEPOSIT = 5_000_000n;
const STAKE_PER_TILE = 1_000n;
/** Tiles 0..17 and 18..35: between them the two players cover the board, so
 *  the round always settles rather than being forfeited to the House. */
const LOWER_TILES = (1n << 18n) - 1n;
const UPPER_TILES = ((1n << 36n) - 1n) ^ LOWER_TILES;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of an Anchor methods builder this file drives. */
interface TxBuilder {
  accountsPartial(accounts: Record<string, PublicKey>): TxBuilder;
  signers(signers: Keypair[]): TxBuilder;
  rpc(): Promise<string>;
}

interface RawPlayer {
  owner: PublicKey;
  principal: BN;
  entries: BN;
  weightAcc: BN;
  lastUpdate: BN;
  epochId: BN;
  frozenWeight: BN;
  frozenEpoch: BN;
  regEpoch: BN;
  regStart: BN;
  regEnd: BN;
  isHouse: boolean;
}

interface RawPosition {
  owner: PublicKey;
  round: PublicKey;
}

describe.skipIf(!RPC_URL)("operator on localnet", () => {
  // Built inside the test: `skipIf` still evaluates this block, and there is
  // no validator (and no RPC url) when the suite is skipped.
  let prisma: PrismaService | null = null;
  const owners: string[] = [];

  afterAll(async () => {
    if (!prisma) return;
    if (owners.length > 0) {
      await prisma.player.deleteMany({ where: { owner: { in: owners } } });
    }
    await prisma.$disconnect();
  });

  it(
    "runs an epoch end to end: rounds settle, players register, the jackpot is paid",
    async () => {
      const connection = new Connection(RPC_URL as string, "confirmed");
      prisma = new PrismaService();
      const authority = Keypair.generate();
      await airdrop(connection, authority.publicKey, 20);
      const mint = await createMint(connection, authority, authority.publicKey, null, 6);
      const treasury = await createAccount(
        connection,
        authority,
        mint,
        authority.publicKey,
        Keypair.generate(),
      );
      const buybackReserve = await createAccount(
        connection,
        authority,
        mint,
        authority.publicKey,
        Keypair.generate(),
      );
      // The operator mints into this when the jackpot is short; it has to
      // exist first, which is what `bootstrap` does in production.
      await getOrCreateAssociatedTokenAccount(connection, authority, mint, authority.publicKey);

      const poolId = BigInt(Date.now());
      const programId = String(loadIdl().address);
      const config = stubConfig({
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        RPC_URL: RPC_URL ?? "",
        PROGRAM_ID: programId,
        POOL_ID: poolId.toString(),
        AUTHORITY_KEYPAIR: bs58.encode(authority.secretKey),
        HEXUSDC_MINT: mint.toBase58(),
        APR_BPS: "500",
        JACKPOT_FLOOR: "10000000",
        FAUCET_AMOUNT: "0",
        FAUCET_INTERVAL_SECONDS: "0",
        CORS_ORIGIN: "http://localhost",
        PORT: "0",
      });

      const chain = new ChainService(connection, config);
      const method = (name: string, ...args: unknown[]): TxBuilder => {
        // SAFETY: Program<Idl> has no generated method types; the name is
        // checked against the IDL right here.
        const factory = (chain.program.methods as Record<string, ((...a: unknown[]) => TxBuilder) | undefined>)[name];
        if (!factory) throw new Error(`instruction ${name} is missing from the IDL`);
        return factory(...args);
      };

      const pool = chain.poolAddress();
      await method("createPool", {
        poolId: new BN(poolId.toString()),
        vrfNetworkState: VRF_NETWORK_STATE,
        epochSeconds: new BN(86_400),
        roundSeconds: new BN(ROUND_SECONDS),
        closeBuffer: new BN(CLOSE_BUFFER),
        vrfTimeout: new BN(120),
        minDeposit: new BN(1_000_000),
      })
        .accountsPartial({
          authority: authority.publicKey,
          pool,
          acceptedMint: mint,
          principalVault: chain.principalVaultAddress(),
          jackpotVault: chain.jackpotVaultAddress(),
          house: chain.playerAddress(authority.publicKey),
          treasury,
          buybackReserve,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Params apply to the next epoch created, so this lands before the
      // operator opens the first one.
      await method("setParams", {
        epochSeconds: new BN(EPOCH_SECONDS),
        roundSeconds: null,
        closeBuffer: null,
        vrfTimeout: null,
        minDeposit: null,
      })
        .accountsPartial({ authority: authority.publicKey, pool })
        .rpc();

      const readPool = async (): Promise<PoolState> => {
        const info = await connection.getAccountInfo(pool);
        if (!info) throw new Error("pool disappeared");
        return decodePool(chain.program, pool, info.data);
      };
      const readEpoch = async (id: bigint): Promise<EpochState | null> => {
        const info = await connection.getAccountInfo(chain.epochAddress(id));
        return info ? decodeEpoch(chain.program, info.data) : null;
      };

      // Stands in for the indexer module: the same two queries, answered off
      // the chain instead of Postgres, plus the Player mirror the operator's
      // winner lookup reads.
      const indexer: IndexerQueries = {
        playersToRegister: async (epochId) => {
          const epoch = await readEpoch(epochId);
          if (!epoch) return [];
          return (await allPlayers(chain, pool))
            .filter(
              (player) =>
                BigInt(player.regEpoch.toString()) !== epochId &&
                registerWeight(player, epoch) > 0n,
            )
            .map((player) => player.owner.toBase58());
        },
        unsettledPositions: async () => {
          const terminal = new Map(
            (await allRounds(chain))
              .filter((round) => round.status !== ROUND_STATUS.OPEN && round.status !== ROUND_STATUS.REQUESTED)
              .map((round) => [round.address.toBase58(), round.roundId]),
          );
          return (await allPositions(chain))
            .filter((position) => terminal.has(position.round.toBase58()))
            .map((position) => ({
              address: positionAddress(chain.programId, position.round, position.owner).toBase58(),
              owner: position.owner.toBase58(),
              // SAFETY: `terminal.has` above already confirmed this key exists.
              roundId: terminal.get(position.round.toBase58()) as bigint,
            }));
        },
      };

      const operator = new OperatorService(chain, prisma, indexer, config);

      let stopped = false;
      const crank = (async () => {
        while (!stopped) {
          await operator.tick();
          await mirrorPlayers(chain, pool, prisma, owners);
          await fulfil(chain, method, authority);
          await sleep(400);
        }
      })();

      try {
        await waitFor(async () => (await readPool()).currentEpochId === 1n, "the first epoch");

        const [a, b] = await Promise.all([
          fundedWallet(connection, authority, mint),
          fundedWallet(connection, authority, mint),
        ]);
        for (const wallet of [a, b]) {
          await method("deposit", new BN(DEPOSIT.toString()))
            .accountsPartial({
              owner: wallet.keypair.publicKey,
              pool,
              player: chain.playerAddress(wallet.keypair.publicKey),
              acceptedMint: mint,
              ownerToken: wallet.token,
              principalVault: chain.principalVaultAddress(),
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
        }
        const balancesBefore = new Map([
          [a.keypair.publicKey.toBase58(), await tokenBalance(connection, a.token)],
          [b.keypair.publicKey.toBase58(), await tokenBalance(connection, b.token)],
        ]);

        // The operator opens rounds on its own; wait for one with enough time
        // left to buy into.
        const roundId = await waitForRound(chain, readPool);
        const round = chain.roundAddress(roundId);
        for (const [wallet, tiles] of [
          [a, LOWER_TILES],
          [b, UPPER_TILES],
        ] as const) {
          await method("buyPosition", new BN(tiles.toString()), new BN(STAKE_PER_TILE.toString()))
            .accountsPartial({
              owner: wallet.keypair.publicKey,
              pool,
              player: chain.playerAddress(wallet.keypair.publicKey),
              round,
              position: positionAddress(chain.programId, round, wallet.keypair.publicKey),
              systemProgram: SystemProgram.programId,
            })
            .signers([wallet.keypair])
            .rpc();
        }

        // The round settles and both Positions are closed by the operator.
        await waitFor(async () => {
          const info = await connection.getAccountInfo(round);
          if (!info) return false;
          return decodeRound(chain.program, info.data).status === ROUND_STATUS.SETTLED;
        }, "the round to settle", 90_000);

        await waitFor(async () => {
          const positions = await Promise.all(
            [a, b].map((wallet) =>
              connection.getAccountInfo(
                positionAddress(chain.programId, round, wallet.keypair.publicKey),
              ),
            ),
          );
          return positions.every((info) => info === null);
        }, "both positions to close", 90_000);

        // Epoch 1 ends: registration, funding, draw, payout, all cranked.
        await waitFor(
          async () => (await readEpoch(1n))?.status === EPOCH_STATUS.PAID,
          "epoch 1 to be paid out",
          150_000,
        );

        const epoch = await readEpoch(1n);
        expect(epoch?.registeredCount).toBe(2);
        expect(epoch?.jackpotAmount).toBe(10_000_000n); // the floor, spec §7

        const info = await connection.getAccountInfo(chain.epochAddress(1n));
        const winner = chain.program.coder.accounts
          .decode<{ winner: PublicKey }>("epoch", info?.data ?? Buffer.alloc(0))
          .winner.toBase58();
        const winnerWallet = [a, b].find((w) => w.keypair.publicKey.toBase58() === winner);
        expect(winnerWallet, `winner ${winner} is one of the two depositors`).toBeDefined();

        const after = await tokenBalance(connection, winnerWallet?.token as PublicKey);
        expect(after - (balancesBefore.get(winner) ?? 0n)).toBe(epoch?.jackpotAmount);
      } finally {
        stopped = true;
        await crank;
      }
    },
    300_000,
  );
});

/** ChainService and OperatorService only ever call `get` on the config. */
function stubConfig(env: HexVaultEnv): ConfigService<HexVaultEnv, true> {
  return {
    get: (key: keyof HexVaultEnv) => env[key],
  } as unknown as ConfigService<HexVaultEnv, true>;
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function fundedWallet(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
): Promise<{ keypair: Keypair; token: PublicKey }> {
  const keypair = Keypair.generate();
  await airdrop(connection, keypair.publicKey, 5);
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    mint,
    keypair.publicKey,
  );
  await mintTo(connection, authority, mint, account.address, authority, 10_000_000n);
  return { keypair, token: account.address };
}

const tokenBalance = async (connection: Connection, address: PublicKey): Promise<bigint> =>
  (await getAccount(connection, address)).amount;

async function programAccounts<T>(
  chain: ChainService,
  name: "player" | "position",
  discriminator: number[],
): Promise<{ address: PublicKey; account: T }[]> {
  const accounts = await chain.connection.getProgramAccounts(chain.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(discriminator)) } }],
  });
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    account: chain.program.coder.accounts.decode<T>(name, account.data),
  }));
}

const allPlayers = async (chain: ChainService, pool: PublicKey): Promise<RawPlayer[]> =>
  (await programAccounts<RawPlayer>(chain, "player", [205, 222, 112, 7, 165, 155, 206, 218]))
    // Other suites may share the validator, so keep to this pool's Players:
    // the PDA is derived from (pool, owner).
    .filter(({ address, account }) =>
      playerAddress(chain.programId, pool, account.owner).equals(address),
    )
    .map(({ account }) => account);

const allPositions = async (chain: ChainService): Promise<RawPosition[]> =>
  (await programAccounts<RawPosition>(chain, "position", [170, 188, 143, 228, 122, 64, 247, 208]))
    .map(({ account }) => account);

/** Every Round on chain, for the fake indexer's sweep to filter by status. */
async function allRounds(
  chain: ChainService,
): Promise<{ address: PublicKey; roundId: bigint; status: number }[]> {
  const coder = chain.program.coder.accounts;
  const accounts = await chain.connection.getProgramAccounts(chain.programId, {
    filters: [{ memcmp: coder.memcmp("round") }],
  });
  return accounts.map(({ pubkey, account }) => {
    const decoded = decodeRound(chain.program, account.data);
    return { address: pubkey, roundId: decoded.roundId, status: decoded.status };
  });
}

/** `epochs::register`'s three weight cases, off the mirrored account. */
function registerWeight(player: RawPlayer, epoch: EpochState): bigint {
  const epochId = BigInt(player.epochId.toString());
  const entries = BigInt(player.entries.toString());
  const lastUpdate = BigInt(player.lastUpdate.toString());
  if (epochId === epoch.epochId) {
    const seconds = epoch.endsAt > lastUpdate ? epoch.endsAt - lastUpdate : 0n;
    return BigInt(player.weightAcc.toString()) + entries * seconds;
  }
  if (epochId > epoch.epochId) {
    return BigInt(player.frozenEpoch.toString()) === epoch.epochId
      ? BigInt(player.frozenWeight.toString())
      : 0n;
  }
  return BigInt(player.principal.toString()) * (epoch.endsAt - epoch.startsAt);
}

/** The Player rows the operator's winner lookup reads out of Postgres. */
async function mirrorPlayers(
  chain: ChainService,
  pool: PublicKey,
  prisma: PrismaService,
  owners: string[],
): Promise<void> {
  for (const player of await allPlayers(chain, pool)) {
    const row = {
      owner: player.owner.toBase58(),
      principal: BigInt(player.principal.toString()),
      entries: BigInt(player.entries.toString()),
      weightAcc: player.weightAcc.toString(),
      lastUpdate: BigInt(player.lastUpdate.toString()),
      epochId: BigInt(player.epochId.toString()),
      frozenWeight: player.frozenWeight.toString(),
      frozenEpoch: BigInt(player.frozenEpoch.toString()),
      regEpoch: BigInt(player.regEpoch.toString()),
      regStart: player.regStart.toString(),
      regEnd: player.regEnd.toString(),
      isHouse: player.isHouse,
    };
    if (!owners.includes(row.owner)) owners.push(row.owner);
    await prisma.player.upsert({ where: { owner: row.owner }, create: row, update: row });
  }
}

/**
 * The oracle. `test-vrf` builds fabricate the fulfilled account instead of
 * waiting for ORAO, so something has to notice a pending request; on devnet
 * ORAO's fulfillers do this.
 */
async function fulfil(
  chain: ChainService,
  method: (name: string, ...args: unknown[]) => TxBuilder,
  authority: Keypair,
): Promise<void> {
  const poolInfo = await chain.connection.getAccountInfo(chain.poolAddress());
  if (!poolInfo) return;
  const pool = decodePool(chain.program, chain.poolAddress(), poolInfo.data);

  const seeds: Uint8Array[] = [];
  if (pool.openRoundId > 0n) {
    const info = await chain.connection.getAccountInfo(chain.roundAddress(pool.openRoundId));
    const round = info ? decodeRound(chain.program, info.data) : null;
    if (round?.status === ROUND_STATUS.REQUESTED) seeds.push(round.vrfSeed);
  }
  if (pool.currentEpochId > 1n) {
    const info = await chain.connection.getAccountInfo(
      chain.epochAddress(pool.currentEpochId - 1n),
    );
    const epoch = info ? decodeEpoch(chain.program, info.data) : null;
    if (epoch?.status === EPOCH_STATUS.DRAWING) seeds.push(epoch.vrfSeed);
  }

  for (const seed of seeds) {
    const address = randomnessAddress(chain.programId, seed, true);
    if (await chain.connection.getAccountInfo(address)) continue;
    // Randomness derived from the seed: deterministic per request, different
    // for every round and epoch.
    const randomness = Uint8Array.from([...seed, ...seed]);
    await method("testFulfill", Array.from(seed), Array.from(randomness))
      .accountsPartial({
        payer: authority.publicKey,
        randomness: address,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}

/** An open round with enough time left before `close_buffer` to buy into. */
async function waitForRound(
  chain: ChainService,
  readPool: () => Promise<PoolState>,
): Promise<bigint> {
  let roundId = 0n;
  await waitFor(async () => {
    const pool = await readPool();
    if (pool.openRoundId === 0n) return false;
    const info = await chain.connection.getAccountInfo(chain.roundAddress(pool.openRoundId));
    if (!info) return false;
    const round = decodeRound(chain.program, info.data);
    const slot = await chain.connection.getSlot();
    const now = BigInt((await chain.connection.getBlockTime(slot)) ?? 0);
    if (round.status !== ROUND_STATUS.OPEN) return false;
    if (now + BigInt(CLOSE_BUFFER) + 4n >= round.endsAt) return false;
    roundId = round.roundId;
    return true;
  }, "an open round with time left to buy into", 90_000);
  return roundId;
}

async function waitFor(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}
