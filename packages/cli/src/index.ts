import { Command, CommanderError } from "commander";

import {
  createContext,
  pda,
  fetchPool,
  type Context,
  type GlobalOptions,
} from "./client.js";
import { chainError, CliError, EXIT_USAGE, print } from "./errors.js";
import { parseAmount, parsePubkey } from "./parse.js";
import { usage } from "./errors.js";
import {
  initialize,
  poolCreate,
  poolIdFrom,
  poolShow,
  setPause,
  status,
} from "./pool-ops.js";
import { epochCreate, epochShow } from "./epoch-ops.js";
import {
  balances,
  buyPosition,
  claimRoundReward,
  deposit,
  fulfillRandomness,
  fulfillVrfRandomness,
  refresh,
  requestRandomness,
  roundCreate,
  roundShow,
  withdraw,
} from "./user-ops.js";
import {
  claimVault,
  commitJackpot,
  commitPrize,
  expireVault,
  fundVault,
  jackpotStatus,
  reconcile,
} from "./prize-ops.js";
import {
  buildSnapshot,
  leavesFromChain,
  leavesFromDb,
  leavesFromIndexerSnapshot,
} from "./snapshot.js";

const program = new Command();

program
  .name("hexvault")
  .description("HexVault operator CLI (localnet/devnet only)")
  .version("0.1.0")
  .exitOverride()
  .option("-u, --url <url>", "cluster rpc url", "http://127.0.0.1:8899")
  .option(
    "-k, --keypair <path>",
    "signing keypair file",
    process.env.HEXVAULT_KEYPAIR,
  )
  .option(
    "--state-dir <dir>",
    "pool state directory",
    process.env.HEXVAULT_STATE_DIR,
  )
  .option("-p, --pool <id>", "default pool id for per-pool commands")
  .option("--text", "human-readable output (JSON is the default)")
  .option("--json", "json output (default)");

type Handler = (
  ctx: Context,
  opts: Record<string, unknown>,
  cmd: Command,
) => Promise<unknown>;

function cmd(name: string, description: string, handler: Handler): Command {
  return program
    .command(name)
    .description(description)
    .action(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const opts = command.optsWithGlobals() as Record<string, unknown> &
        GlobalOptions;
      const json = !opts.text;
      const ctx = createContext(opts, json);
      pda.bind(ctx.programId);
      const payload = await handler(ctx, opts, command);
      print(payload, json);
    });
}

function poolOf(opts: Record<string, unknown>): bigint {
  return poolIdFrom(opts as { poolId?: string; pool?: string });
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new CliError(EXIT_USAGE, `${flag} is required`);
  return value;
}

cmd(
  "initialize",
  "initialize the protocol (signer must be the program upgrade authority)",
  async (ctx, o) =>
    initialize(ctx, {
      guardian: required(o.guardian as string, "--guardian"),
      snapshot: required(o.snapshot as string, "--snapshot"),
      mockRandomness: required(o.mockRandomness as string, "--mock-randomness"),
      ...(o.vrfState ? { vrfState: o.vrfState as string } : {}),
    }),
)
  .requiredOption("--guardian <pubkey>")
  .requiredOption("--snapshot <pubkey>")
  .requiredOption("--mock-randomness <pubkey>")
  .option(
    "--vrf-state <pubkey>",
    "ORAO VRF network-state account (omit for mock-only localnet)",
  );

const pool = program.command("pool").description("pool lifecycle");
pool
  .command("create")
  .description(
    "create a pool (generates and persists the receipt mint keypairs)",
  )
  .requiredOption("--pool-id <n>")
  .requiredOption("--mint <pubkey>", "accepted asset mint")
  .option(
    "--token-program <pubkey>",
    "accepted asset token program (default: the mint's on-chain owner)",
  )
  .requiredOption("--min-deposit <n>")
  .requiredOption("--max-stake <n>")
  .requiredOption("--max-bonus <n>")
  .requiredOption("--min-epoch-seconds <n>")
  .requiredOption("--max-epoch-seconds <n>")
  .requiredOption("--buffer-seconds <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    const tokenProgram =
      typeof opts.tokenProgram === "string" && opts.tokenProgram.length > 0
        ? opts.tokenProgram
        : ((
            await ctx.connection.getAccountInfo(
              parsePubkey(String(opts.mint), "--mint"),
            )
          )?.owner.toBase58() ??
          (() => {
            throw usage(
              `mint ${String(opts.mint)} not found on chain; pass --token-program`,
            );
          })());
    print(
      await poolCreate(ctx, {
        poolId: String(opts.poolId),
        mint: String(opts.mint),
        tokenProgram,
        minDeposit: String(opts.minDeposit),
        maxStake: String(opts.maxStake),
        maxBonus: String(opts.maxBonus),
        minEpochSeconds: String(opts.minEpochSeconds),
        maxEpochSeconds: String(opts.maxEpochSeconds),
        bufferSeconds: String(opts.bufferSeconds),
      }),
      !opts.text,
    );
  });
pool
  .command("show")
  .description("decode the pool account and vault balances")
  .requiredOption("--pool-id <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await poolShow(ctx, parseAmount(String(opts.poolId), "--pool-id")),
      !opts.text,
    );
  });

cmd(
  "status",
  "protocol config plus every pool tracked in the state dir",
  (ctx) => status(ctx),
);

cmd(
  "pause",
  "guardian pause switch: hexvault pause on|off --pool-id N",
  async (ctx, o) => {
    const [mode] = o.args as string[];
    return setPause(ctx, String(mode), poolOf(o));
  },
).argument("<mode>", "on|off");

const epoch = program.command("epoch").description("epoch lifecycle");
const epochFlags = epoch.command("create");
epochFlags
  .description("create the first epoch, or begin the next one when one exists")
  .requiredOption("--pool-id <n>")
  .option("--id <n>", "epoch id (defaults to latest + 1)")
  .requiredOption("--starts <time>")
  .requiredOption("--cutoff <time>")
  .requiredOption("--ends <time>")
  .requiredOption("--snapshot <time>")
  .requiredOption("--deadline <time>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await epochCreate(
        ctx,
        timingOpts(opts),
        parseAmount(String(opts.poolId)),
      ),
      !opts.text,
    );
  });
epoch
  .command("next")
  .description("alias of `epoch create` for pools with a prior epoch")
  .requiredOption("--pool-id <n>")
  .option("--id <n>")
  .requiredOption("--starts <time>")
  .requiredOption("--cutoff <time>")
  .requiredOption("--ends <time>")
  .requiredOption("--snapshot <time>")
  .requiredOption("--deadline <time>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await epochCreate(
        ctx,
        timingOpts(opts),
        parseAmount(String(opts.poolId)),
      ),
      !opts.text,
    );
  });
epoch
  .command("show")
  .requiredOption("--pool-id <n>")
  .requiredOption("--id <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await epochShow(
        ctx,
        parseAmount(String(opts.poolId)),
        parseAmount(String(opts.id), "--id"),
      ),
      !opts.text,
    );
  });

function timingOpts(o: Record<string, unknown>) {
  return {
    id: o.id as string | undefined,
    starts: required(o.starts as string, "--starts"),
    cutoff: required(o.cutoff as string, "--cutoff"),
    ends: required(o.ends as string, "--ends"),
    snapshot: required(o.snapshot as string, "--snapshot"),
    deadline: required(o.deadline as string, "--deadline"),
  };
}

cmd("deposit", "deposit the accepted asset and mint PT + ET", async (ctx, o) =>
  deposit(ctx, poolOf(o), required(o.amount as string, "--amount")),
)
  .requiredOption("--pool-id <n>")
  .requiredOption("--amount <n>");

cmd(
  "withdraw",
  "burn PT and ET and withdraw principal (works while paused)",
  async (ctx, o) =>
    withdraw(ctx, poolOf(o), required(o.amount as string, "--amount")),
)
  .requiredOption("--pool-id <n>")
  .requiredOption("--amount <n>");

cmd(
  "refresh",
  "refresh entries (ET := PT) for the current epoch",
  async (ctx, o) => refresh(ctx, poolOf(o)),
).requiredOption("--pool-id <n>");

cmd(
  "balances",
  "accepted, PT, ET and withdrawable balances for an owner",
  async (ctx, o) => balances(ctx, poolOf(o), o.owner as string | undefined),
)
  .requiredOption("--pool-id <n>")
  .option("--owner <pubkey>", "defaults to the CLI wallet");

const round = program.command("round").description("round lifecycle");
round
  .command("create")
  .requiredOption("--pool-id <n>")
  .requiredOption("--round-id <n>")
  .requiredOption("--starts <time>")
  .requiredOption("--ends <time>")
  .requiredOption("--bonus <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await roundCreate(ctx, parseAmount(String(opts.poolId)), {
        roundId: String(opts.roundId),
        starts: String(opts.starts),
        ends: String(opts.ends),
        bonus: String(opts.bonus),
      }),
      !opts.text,
    );
  });
round
  .command("show")
  .requiredOption("--pool-id <n>")
  .requiredOption("--round-id <n>")
  .option("--epoch-id <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await roundShow(
        ctx,
        parseAmount(String(opts.poolId)),
        parseAmount(String(opts.roundId)),
        opts.epochId ? parseAmount(String(opts.epochId)) : undefined,
      ),
      !opts.text,
    );
  });

const position = program.command("position").description("position lifecycle");
position
  .command("buy")
  .requiredOption("--pool-id <n>")
  .requiredOption("--round-id <n>")
  .requiredOption("--tiles <list>", "comma separated tile list, e.g. 1,7,22")
  .requiredOption("--stake <n>", "stake per tile, atomic units")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(
      await buyPosition(ctx, parseAmount(String(opts.poolId)), {
        roundId: String(opts.roundId),
        tiles: String(opts.tiles),
        stake: String(opts.stake),
      }),
      !opts.text,
    );
  });

const randomness = program.command("randomness");
randomness
  .command("request")
  .argument("<kind>", "round|prize|jackpot")
  .requiredOption("--pool-id <n>")
  .option("--round-id <n>")
  .option("--epoch-id <n>")
  .option("--seed <hex>", "32-byte client seed (random when omitted)")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    const kind = parseKind(String(opts.kind ?? command.args[0]));
    print(
      await requestRandomness(
        ctx,
        kind,
        parseAmount(String(opts.poolId)),
        subjectId(kind, opts),
        opts.epochId ? parseAmount(String(opts.epochId)) : undefined,
        opts.seed as string | undefined,
      ),
      !opts.text,
    );
  });
randomness
  .command("fulfill")
  .argument("<kind>", "round|prize|jackpot")
  .requiredOption("--pool-id <n>")
  .option("--round-id <n>")
  .option("--epoch-id <n>")
  .requiredOption("--sample <n>")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    const kind = parseKind(String(opts.kind ?? command.args[0]));
    print(
      await fulfillRandomness(
        ctx,
        kind,
        parseAmount(String(opts.poolId)),
        subjectId(kind, opts),
        String(opts.sample),
        opts.epochId ? parseAmount(String(opts.epochId)) : undefined,
      ),
      !opts.text,
    );
  });
randomness
  .command("fulfill-vrf")
  .description(
    "permissionless settle from the ORAO VRF (pull): submits the bound randomness to the program",
  )
  .argument("<kind>", "round|prize|jackpot")
  .requiredOption("--pool-id <n>")
  .option("--round-id <n>")
  .option("--epoch-id <n>")
  .option(
    "--vrf-state <pubkey>",
    "ORAO network-state account (default: ORAO's canonical PDA)",
  )
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    const kind = parseKind(String(opts.kind ?? command.args[0]));
    print(
      await fulfillVrfRandomness(
        ctx,
        kind,
        parseAmount(String(opts.poolId)),
        subjectId(kind, opts),
        opts.epochId ? parseAmount(String(opts.epochId)) : undefined,
        opts.vrfState as string | undefined,
      ),
      !opts.text,
    );
  });

function parseKind(raw: string): "round" | "prize" | "jackpot" {
  if (raw === "round" || raw === "prize" || raw === "jackpot") return raw;
  throw new CliError(
    EXIT_USAGE,
    `randomness kind must be round|prize|jackpot, got "${raw}"`,
  );
}

function subjectId(
  kind: "round" | "prize" | "jackpot",
  o: Record<string, unknown>,
): bigint {
  const flag = kind === "round" ? "--round-id" : "--epoch-id";
  return parseAmount(
    required(o[kind === "round" ? "roundId" : "epochId"] as string, flag),
    flag,
  );
}

cmd("reward", "claim a settled round reward", async (ctx, o) =>
  claimRoundReward(
    ctx,
    poolOf(o),
    parseAmount(required(o.roundId as string, "--round-id"), "--round-id"),
    o.epochId ? parseAmount(String(o.epochId)) : undefined,
  ),
)
  .requiredOption("--pool-id <n>")
  .requiredOption("--round-id <n>")
  .option("--epoch-id <n>");

const prize = program
  .command("prize")
  .description("prize funding, snapshot commit and claims");
prize
  .command("fund")
  .requiredOption("--pool-id <n>")
  .requiredOption("--amount <n>")
  .action(
    wrap(async (ctx, o) =>
      fundVault(ctx, "prize", parseAmount(String(o.poolId)), String(o.amount)),
    ),
  );
prize
  .command("commit")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .requiredOption("--snapshot-file <path>")
  .requiredOption("--prize-amount <n>")
  .action(
    wrap(async (ctx, o) =>
      commitPrize(
        ctx,
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
        String(o.snapshotFile),
        String(o.prizeAmount),
      ),
    ),
  );
prize
  .command("claim")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .option("--winner <pubkey>", "defaults to the CLI wallet")
  .option("--weight <n>", "must match the snapshot entry when given")
  .requiredOption("--proof-file <path>")
  .action(
    wrap(async (ctx, o) =>
      claimVault(
        ctx,
        "prize",
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
        {
          winner: o.winner as string | undefined,
          weight: o.weight as string | undefined,
          proofFile: o.proofFile as string | undefined,
        },
      ),
    ),
  );
prize
  .command("expire")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .action(
    wrap(async (ctx, o) =>
      expireVault(
        ctx,
        "prize",
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
      ),
    ),
  );

const jackpot = program
  .command("jackpot")
  .description("jackpot funding, commit and claims");
jackpot
  .command("fund")
  .requiredOption("--pool-id <n>")
  .requiredOption("--amount <n>")
  .action(
    wrap(async (ctx, o) =>
      fundVault(
        ctx,
        "jackpot",
        parseAmount(String(o.poolId)),
        String(o.amount),
      ),
    ),
  );
jackpot
  .command("commit")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .description("commits the current jackpot vault balance (no amount flag)")
  .action(
    wrap(async (ctx, o) =>
      commitJackpot(
        ctx,
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
      ),
    ),
  );
jackpot
  .command("claim")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .option("--winner <pubkey>")
  .option("--weight <n>")
  .requiredOption("--proof-file <path>")
  .action(
    wrap(async (ctx, o) =>
      claimVault(
        ctx,
        "jackpot",
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
        {
          winner: o.winner as string | undefined,
          weight: o.weight as string | undefined,
          proofFile: o.proofFile as string | undefined,
        },
      ),
    ),
  );
jackpot
  .command("expire")
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .action(
    wrap(async (ctx, o) =>
      expireVault(
        ctx,
        "jackpot",
        parseAmount(String(o.poolId)),
        parseAmount(String(o.epochId)),
      ),
    ),
  );
jackpot
  .command("status")
  .requiredOption("--pool-id <n>")
  .option("--epoch-id <n>")
  .action(
    wrap(async (ctx, o) =>
      jackpotStatus(
        ctx,
        parseAmount(String(o.poolId)),
        o.epochId ? parseAmount(String(o.epochId)) : undefined,
      ),
    ),
  );

const snapshot = program.command("snapshot");
snapshot
  .command("export")
  .description(
    "build the Merkle-sum snapshot (root + per-player proofs) from the indexer or chain",
  )
  .requiredOption("--pool-id <n>")
  .requiredOption("--epoch-id <n>")
  .option(
    "--db <url>",
    "indexer Postgres connection string",
    process.env.HEXVAULT_DATABASE_URL,
  )
  .option("--out <path>", "output file", "./snapshot.json")
  .option("--table <name>", "entries table name override")
  .action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    const poolId = parseAmount(String(opts.poolId));
    const epochId = parseAmount(String(opts.epochId));
    const dbUrl = opts.db ? String(opts.db) : undefined;
    const outPath = String(opts.out ?? "./snapshot.json");
    let rows: { owner: string; weight: bigint }[];
    let source: string;
    let indexerRoot: string | undefined;
    if (dbUrl) {
      const snap = await leavesFromIndexerSnapshot(
        dbUrl,
        pda.pool(poolId).toBase58(),
        epochId,
      );
      if (snap) {
        rows = snap.rows;
        source = "indexer";
        indexerRoot = snap.indexerRoot;
      } else {
        const legacy = await leavesFromDb(
          dbUrl,
          poolId,
          epochId,
          opts.table as string | undefined,
        );
        rows = legacy.rows;
        source = "db";
      }
    } else {
      rows = (
        await leavesFromChain(ctx, (await fetchPool(ctx, poolId)).entryMint)
      ).rows;
      source = "chain";
    }
    const result = await buildSnapshot(
      {
        pool: pda.pool(poolId).toBase58(),
        epochId: String(epochId),
        source,
        table: opts.table as string | undefined,
        out: outPath,
      },
      rows,
    );
    if (indexerRoot && indexerRoot !== result.file.root.replace(/^0x/, "")) {
      throw chainError(
        `locally rebuilt root ${result.file.root} differs from the indexer's canonical root ${indexerRoot}; ` +
          "indexed state and leaves disagree — do not commit this snapshot",
      );
    }
    print(
      {
        path: result.path,
        root: result.file.root,
        totalWeight: result.file.totalWeight,
        players: result.file.players.length,
        source: result.file.source,
        snapshot: result.file,
      },
      !opts.text,
    );
  });

cmd("reconcile", "on-chain solvency checks for a pool", async (ctx, o) => {
  const verdict = await reconcile(ctx, poolOf(o));
  if (verdict.failed > 0) process.exitCode = 4;
  return verdict;
}).requiredOption("--pool-id <n>");

/** Shared action wrapper: build ctx, run, print. */
function wrap(
  handler: (ctx: Context, opts: Record<string, unknown>) => Promise<unknown>,
) {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const opts = command.optsWithGlobals() as Record<string, unknown>;
    const ctx = createContext(opts as never, !opts.text);
    pda.bind(ctx.programId);
    print(await handler(ctx, opts), !opts.text);
  };
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code !== "commander.helpDisplayed" &&
        err.code !== "commander.version"
      ) {
        console.error(`${err.message}`);
      }
      process.exit(2);
    }
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      process.exit(err.code);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    process.exit(1);
  }
}

await main();
