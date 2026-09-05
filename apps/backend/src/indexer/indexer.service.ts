import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { EventParser } from "@anchor-lang/core";
import type { Epoch, Player, Prisma, Round } from "@prisma/client";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";

import { ChainService } from "../chain/chain.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  decodeEventLogs,
  epochRow,
  LIVE_ROUND_STATUSES,
  playerRow,
  poolRow,
  positionRow,
  registrationWeight,
  roundRow,
  type DecodedEpoch,
  type DecodedEvent,
  type DecodedPlayer,
  type DecodedPool,
  type DecodedPosition,
  type DecodedRound,
} from "./decode";

const SYNC_INTERVAL_MS = 2_000;
const CURSOR_ID = 1;
// One page of `getSignaturesForAddress`. Beyond this the oldest signatures
// behind the cursor are dropped, which only happens if the indexer was down
// for longer than 1000 program transactions.
// ponytail: single page, paginate with `before` if downtime gets that long.
const SIGNATURE_PAGE = 1_000;

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

// Anchor's `Program` runs the IDL through `convertIdlToCamelCase` before it
// builds the coder, so the coder knows `Pool` as `pool`. A wrong name here
// throws "Account not found", it never decodes the wrong layout.
const ACCOUNT = {
  pool: "pool",
  epoch: "epoch",
  round: "round",
  player: "player",
  position: "position",
} as const;

/** One transaction's finalized logs, the unit both ingest paths hand over. */
export interface LogBatch {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  logs: string[];
}

interface SocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Mirrors program accounts and finalized events into Postgres (spec §3.3) and
 * answers the reads the operator and the API make, so neither hammers the RPC.
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private readonly parser: EventParser;

  private timer?: NodeJS.Timeout;
  private subscriptionId?: number;
  /** Single-flight: a slow tick is skipped, never queued behind itself. */
  private ticking = false;
  /** Serializes the live socket and the catch-up poll onto one writer. */
  private queue: Promise<void> = Promise.resolve();
  private lastFailure: string | undefined;
  private socketState = "connected";

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
  ) {
    this.parser = new EventParser(this.chain.programId, this.chain.program.coder);
  }

  onModuleInit(): void {
    this.watchSocket();
    this.subscribeToLogs();
    this.timer = setInterval(() => void this.tick(), SYNC_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.subscriptionId !== undefined) {
      await this.chain.connection.removeOnLogsListener(this.subscriptionId);
    }
    await this.queue;
  }

  // ---------------------------------------------------------------- reads

  getPlayers(): Promise<Player[]> {
    return this.prisma.player.findMany();
  }

  /** The round the operator may still act on, newest first. */
  getOpenRound(): Promise<Round | null> {
    return this.prisma.round.findFirst({
      where: { status: { in: LIVE_ROUND_STATUSES } },
      orderBy: { id: "desc" },
    });
  }

  getEpoch(id: bigint): Promise<Epoch | null> {
    return this.prisma.epoch.findUnique({ where: { id } });
  }

  /** Owners the operator still owes a `register` for this ended epoch. */
  async playersToRegister(epochId: bigint): Promise<string[]> {
    const epoch = await this.prisma.epoch.findUnique({ where: { id: epochId } });
    if (!epoch) return [];
    const players = await this.prisma.player.findMany({
      where: { regEpoch: { not: epochId } },
    });
    return players
      .filter((player) => registrationWeight(player, epoch) > 0n)
      .map((player) => player.owner);
  }

  /**
   * Positions still on chain whose Round is Settled, Forfeited or Voided,
   * across every such Round, so still worth a `settle_position`. Position has
   * no Prisma relation to Round (just its id), so this is two queries.
   */
  async unsettledPositions(): Promise<{ address: string; owner: string; roundId: bigint }[]> {
    const terminalRounds = await this.prisma.round.findMany({
      where: { status: { notIn: LIVE_ROUND_STATUSES } },
      select: { id: true },
    });
    if (terminalRounds.length === 0) return [];
    return this.prisma.position.findMany({
      where: { roundId: { in: terminalRounds.map((round) => round.id) } },
      select: { address: true, owner: true, roundId: true },
    });
  }

  // ------------------------------------------------------------- the tick

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncAccounts();
      await this.catchUpEvents();
      await this.prisma.cursor.upsert({
        where: { id: CURSOR_ID },
        create: { id: CURSOR_ID, updatedAt: nowSeconds() },
        update: { updatedAt: nowSeconds() },
      });
      this.noteRecovery();
    } catch (error) {
      this.noteFailure("indexer tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  // --------------------------------------------------------- account sync

  /**
   * One `getProgramAccounts` per account type, filtered by the 8-byte Anchor
   * discriminator, then one Prisma transaction per type.
   *
   * Every account is checked against the PDA it must live at for the
   * configured pool. Epoch, Round and Player carry no pool field, and the
   * Postgres tables are keyed by epoch id, round id and owner, so a second
   * pool's accounts would collide with this one's.
   */
  async syncAccounts(): Promise<void> {
    const slot = BigInt(await this.chain.connection.getSlot("confirmed"));
    const pool = this.chain.poolAddress();

    const pools = await this.fetch<DecodedPool>(ACCOUNT.pool);
    await this.prisma.$transaction(
      pools
        .filter(({ pubkey }) => pubkey.equals(pool))
        .map(({ pubkey, account }) => {
          const row = poolRow(pubkey, account, slot);
          return this.prisma.pool.upsert({
            where: { address: row.address },
            create: row,
            update: row,
          });
        }),
    );

    const epochs = await this.fetch<DecodedEpoch>(ACCOUNT.epoch);
    await this.prisma.$transaction(
      epochs
        .filter(({ pubkey, account }) =>
          pubkey.equals(this.chain.epochAddress(BigInt(account.epochId.toString()), pool)),
        )
        .map(({ account }) => {
          const row = epochRow(account);
          return this.prisma.epoch.upsert({ where: { id: row.id }, create: row, update: row });
        }),
    );

    const rounds = (await this.fetch<DecodedRound>(ACCOUNT.round)).filter(({ pubkey, account }) =>
      pubkey.equals(this.chain.roundAddress(BigInt(account.roundId.toString()), pool)),
    );
    await this.prisma.$transaction(
      rounds.map(({ account }) => {
        const row = roundRow(account);
        return this.prisma.round.upsert({ where: { id: row.id }, create: row, update: row });
      }),
    );

    const players = await this.fetch<DecodedPlayer>(ACCOUNT.player);
    await this.prisma.$transaction(
      players
        .filter(({ pubkey, account }) => pubkey.equals(this.chain.playerAddress(account.owner, pool)))
        .map(({ account }) => {
          const row = playerRow(account);
          return this.prisma.player.upsert({
            where: { owner: row.owner },
            create: row,
            update: row,
          });
        }),
    );

    // Position stores its round's address, not its id, so the ids come from
    // the rounds decoded a moment ago. Rounds are never closed, so a position
    // of this pool always finds its round here.
    const roundIds = new Map(
      rounds.map(({ pubkey, account }) => [pubkey.toBase58(), BigInt(account.roundId.toString())]),
    );
    const positions = (await this.fetch<DecodedPosition>(ACCOUNT.position)).flatMap(
      ({ pubkey, account }) => {
        const roundId = roundIds.get(account.round.toBase58());
        if (roundId === undefined) return [];
        if (!pubkey.equals(this.chain.positionAddress(account.round, account.owner))) return [];
        return [positionRow(pubkey, account, roundId)];
      },
    );
    const live = positions.map((row) => row.address);
    await this.prisma.$transaction([
      ...positions.map((row) =>
        this.prisma.position.upsert({
          where: { address: row.address },
          create: row,
          update: row,
        }),
      ),
      // `settle_position` and `void_round` close the account and refund the
      // rent, so a row with no account behind it is a settled position.
      this.prisma.position.deleteMany({
        where: live.length > 0 ? { address: { notIn: live } } : {},
      }),
    ]);
  }

  private async fetch<T>(
    name: string,
  ): Promise<{ pubkey: PublicKey; account: T }[]> {
    const coder = this.chain.program.coder.accounts;
    const accounts = await this.chain.connection.getProgramAccounts(this.chain.programId, {
      filters: [{ memcmp: coder.memcmp(name) }],
    });
    return accounts.map(({ pubkey, account }) => ({
      pubkey,
      account: coder.decode<T>(name, account.data),
    }));
  }

  // --------------------------------------------------------- event ingest

  /**
   * Stores one transaction's events and advances the cursor in the same
   * database transaction, so a crash never leaves the cursor ahead of the
   * rows. The composite primary key makes a replayed batch a no-op.
   *
   * Returns the number of rows actually inserted.
   */
  async ingestLogs(batch: LogBatch): Promise<number> {
    const events = decodeEventLogs(this.parser, batch.logs);
    return this.persist(batch, events);
  }

  private persist(batch: LogBatch, events: DecodedEvent[]): Promise<number> {
    const rows = events.map((event, index) => ({
      slot: batch.slot,
      signature: batch.signature,
      index,
      name: event.name,
      // SAFETY: an Anchor event always decodes to a struct, so `jsonify`
      // returned an object here, which is what jsonb columns take.
      data: event.data as Prisma.InputJsonObject,
      blockTime: batch.blockTime,
    }));

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.event.createMany({ data: rows, skipDuplicates: true });
      const cursor = await tx.cursor.findUnique({ where: { id: CURSOR_ID } });
      // The live socket and the catch-up poll both write; only the poll walks
      // backwards, and it must not drag the resume point back with it.
      const reached = cursor?.lastSlot ?? null;
      if (reached === null || reached <= batch.slot) {
        const at = { lastSignature: batch.signature, lastSlot: batch.slot, updatedAt: nowSeconds() };
        await tx.cursor.upsert({
          where: { id: CURSOR_ID },
          create: { id: CURSOR_ID, ...at },
          update: at,
        });
      }
      return created.count;
    });
  }

  /**
   * Replays every finalized signature the cursor has not seen. Runs on the 2 s
   * tick, not only at boot: it is what actually guarantees no event is lost
   * when the websocket is down, and it costs one RPC call when nothing moved.
   */
  private async catchUpEvents(): Promise<void> {
    const cursor = await this.prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
    const signatures = await this.chain.connection.getSignaturesForAddress(
      this.chain.programId,
      cursor?.lastSignature
        ? { until: cursor.lastSignature, limit: SIGNATURE_PAGE }
        : { limit: SIGNATURE_PAGE },
      "finalized",
    );

    // Newest first from the RPC; replay oldest first so the cursor only moves
    // forward.
    for (const info of [...signatures].reverse()) {
      const consumed = await this.enqueue(() => this.ingestSignature(info));
      if (!consumed) return;
    }
  }

  /**
   * False when the transaction's logs could not be read. The cursor then stays
   * put and the rest of the page waits for the next tick, because skipping it
   * would drop its events for good.
   */
  private async ingestSignature(info: ConfirmedSignatureInfo): Promise<boolean> {
    const batch: LogBatch = {
      signature: info.signature,
      slot: BigInt(info.slot),
      blockTime:
        info.blockTime === null || info.blockTime === undefined ? null : BigInt(info.blockTime),
      logs: [],
    };
    // A failed transaction committed nothing, so it has no events. The cursor
    // still moves past it, otherwise every tick re-lists it forever.
    if (info.err) {
      await this.persist(batch, []);
      return true;
    }
    const tx = await this.chain.connection.getTransaction(info.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages;
    if (!logs) {
      this.noteFailure(`no finalized logs yet for ${info.signature}`);
      return false;
    }
    await this.persist({ ...batch, logs }, decodeEventLogs(this.parser, logs));
    return true;
  }

  private subscribeToLogs(): void {
    this.subscriptionId = this.chain.connection.onLogs(
      this.chain.programId,
      (logs, context) => {
        if (logs.err) return;
        void this.enqueue(async () => {
          const events = decodeEventLogs(this.parser, logs.logs);
          if (events.length === 0) return;
          await this.persist(
            {
              signature: logs.signature,
              slot: BigInt(context.slot),
              blockTime: await this.blockTime(context.slot),
              logs: logs.logs,
            },
            events,
          );
        }).catch((error: unknown) => this.noteFailure("live log ingest failed", error));
      },
      "finalized",
    );
  }

  /** onLogs carries no block time; the catch-up poll gets it for free. */
  private async blockTime(slot: number): Promise<bigint | null> {
    try {
      const seconds = await this.chain.connection.getBlockTime(slot);
      return seconds === null ? null : BigInt(seconds);
    } catch (error) {
      this.noteFailure(`no block time for slot ${slot}`, error);
      return null;
    }
  }

  /**
   * web3.js owns the websocket: rpc-websockets reconnects it with its own
   * backoff and web3.js re-sends every subscription when it reopens, so a
   * second reconnect loop here would fight it. What is missing is visibility,
   * so the state transitions get logged once each.
   */
  private watchSocket(): void {
    // SAFETY: `_rpcWebSocket` is the rpc-websockets client the Connection
    // builds in its constructor. It is not in the public types, so a version
    // that drops it falls through to the warning instead of throwing. Nothing
    // here mutates it.
    const socket = (this.chain.connection as unknown as { _rpcWebSocket?: SocketLike })
      ._rpcWebSocket;
    if (typeof socket?.on !== "function") {
      this.logger.warn("no websocket handle on the connection; socket state is not logged");
      return;
    }
    socket.on("open", () => this.noteSocketState("connected"));
    socket.on("close", () => this.noteSocketState("disconnected, web3.js is reconnecting"));
    socket.on("error", () => this.noteSocketState("errored, web3.js is reconnecting"));
  }

  private noteSocketState(state: string): void {
    if (state === this.socketState) return;
    this.socketState = state;
    this.logger.log(`rpc websocket ${state}`);
  }

  /** Keeps one writer: the socket callback never interleaves with the poll. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** A failing RPC repeats every 2 s; log the change, not the repetition. */
  private noteFailure(scope: string, error?: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const line = error === undefined ? scope : `${scope}: ${message}`;
    if (line === this.lastFailure) return;
    this.lastFailure = line;
    this.logger.error(line, error instanceof Error ? error.stack : undefined);
  }

  private noteRecovery(): void {
    if (this.lastFailure === undefined) return;
    this.lastFailure = undefined;
    this.logger.log("indexer recovered");
  }
}
