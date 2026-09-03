import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";

import { chainError, usage } from "./errors.js";
import {
  buildTree,
  type SnapshotEntry,
  type ProofNodeJson,
  type SnapshotTree,
} from "./merkle.js";
import type { Context } from "./client.js";

export interface SnapshotFile {
  pool: string;
  epochId: string;
  root: string;
  totalWeight: string;
  source: string;
  players: {
    owner: string;
    weight: string;
    proof: ProofNodeJson[];
  }[];
}

/** Row shape the CLI expects from the indexer's entries table. */
export interface DbLeaves {
  table: string;
  rows: { owner: string; weight: bigint }[];
  /** Canonical root the indexer computed, when read from `snapshots`. */
  indexerRoot?: string;
}

/**
 * Reads the durable canonical snapshot the indexer persisted at the epoch's
 * cutoff — the authoritative at-snapshot entry state even if rewards were
 * claimed or entries refreshed afterwards. Prefers this over raw entry tables
 * because those drift as later events land.
 */
export async function leavesFromIndexerSnapshot(
  connectionString: string,
  poolAddress: string,
  epochId: bigint,
): Promise<DbLeaves | null> {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    throw chainError(`cannot reach Postgres: ${describe(err)}`);
  }
  try {
    const present = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_name='snapshots'",
    );
    if (present.rowCount === 0) return null;
    const result = await client.query<{
      root: Buffer;
      leaves: { owner: string; weight: string }[] | null;
    }>(
      "select root, leaves from snapshots where pool=$1 and epoch_id=$2 order by cutoff_slot desc limit 1",
      [poolAddress, epochId.toString()],
    );
    const row = result.rows[0];
    if (!row || !row.leaves || row.leaves.length === 0) return null;
    return {
      table: "snapshots (indexer canonical)",
      indexerRoot: Buffer.from(row.root).toString("hex"),
      rows: row.leaves
        .map((l) => ({ owner: l.owner, weight: BigInt(l.weight) }))
        .filter((l) => l.weight > 0n)
        .sort((a, b) => a.owner.localeCompare(b.owner)),
    };
  } finally {
    await client.end();
  }
}

const TABLE_CANDIDATES = [
  "player_entries",
  "entries",
  "snapshot_entries",
  "player_balances",
];

const OWNER_COLUMNS = ["owner", "player", "owner_pubkey", "authority"];
const WEIGHT_COLUMNS = [
  "weight",
  "entry_weight",
  "entries",
  "entry_amount",
  "balance",
];

/**
 * Reads per-player entry weights from the indexer's Postgres. The table is
 * discovered from a small candidate list (and can be forced with `--table`);
 * weights must be net entries for the epoch, already reduced by the indexer.
 */
export async function leavesFromDb(
  connectionString: string,
  poolId: bigint,
  epochId: bigint,
  forcedTable?: string,
): Promise<DbLeaves> {
  const pg = await import("pg");
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (err) {
    throw chainError(`cannot reach Postgres: ${describe(err)}`);
  }
  try {
    const tables = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const present = tables.rows.map((r) => r.table_name);
    const table =
      forcedTable ?? TABLE_CANDIDATES.find((t) => present.includes(t));
    if (!table) {
      throw usage(
        `no entries table in Postgres (looked for ${TABLE_CANDIDATES.join(", ")}); ` +
          `tables present: ${present.join(", ")}. Create the indexer's player_entries ` +
          "projection or pass --table.",
      );
    }
    const cols = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name=$1",
      [table],
    );
    const names = cols.rows.map((r) => r.column_name);
    const pick = (candidates: string[], what: string): string => {
      const found = candidates.find((c) => names.includes(c));
      if (!found)
        throw usage(
          `table ${table} has no ${what} column (has: ${names.join(", ")})`,
        );
      return found;
    };
    const ownerCol = pick(OWNER_COLUMNS, "owner");
    const weightCol = pick(WEIGHT_COLUMNS, "weight");
    const filters: string[] = [];
    const params: (string | number)[] = [];
    if (names.includes("pool_id")) {
      filters.push(`pool_id = $${params.push(poolId.toString())}`);
    } else if (names.includes("pool")) {
      filters.push(`pool = $${params.push(poolId.toString())}`);
    }
    if (names.includes("epoch_id")) {
      filters.push(`epoch_id = $${params.push(epochId.toString())}`);
    }
    const where = filters.length === 0 ? "" : `where ${filters.join(" and ")}`;
    const sql =
      `select ${ownerCol} as owner, sum(${weightCol}) as weight from ${table} ` +
      `${where} group by ${ownerCol} having sum(${weightCol}) > 0 order by ${ownerCol}`;
    const result = await client.query<{ owner: string; weight: string }>(
      sql,
      params,
    );
    return {
      table,
      rows: result.rows.map((r) => ({
        owner: r.owner,
        weight: BigInt(r.weight),
      })),
    };
  } finally {
    await client.end();
  }
}

function describe(err: unknown): string {
  const e = err as { message?: string };
  return e?.message ?? String(err);
}

/**
 * Reads entry weights straight from chain: every Token-2022 account holding the
 * pool's entry mint. Authoritative, DB-free fallback (localnet/devnet sized).
 */
export async function leavesFromChain(
  ctx: Context,
  entryMint: PublicKey,
): Promise<DbLeaves> {
  const accounts = await ctx.connection.getProgramAccounts(
    TOKEN_2022_PROGRAM_ID,
    {
      commitment: "finalized",
      filters: [{ memcmp: { offset: 0, bytes: entryMint.toBase58() } }],
    },
  );
  const rows: { owner: string; weight: bigint }[] = [];
  for (const { account } of accounts) {
    // Base token-account layout (mint 32 | owner 32 | amount 8) is fixed;
    // Token-2022 extensions (e.g. ImmutableOwner on ET ATAs) append AFTER it,
    // so length varies but these offsets do not.
    const data = account.data;
    if (data.length < 72) continue;
    const amount = Buffer.from(data.subarray(64, 72)).readBigUInt64LE();
    if (amount === 0n) continue;
    rows.push({
      owner: new PublicKey(data.subarray(32, 64)).toBase58(),
      weight: amount,
    });
  }
  return { table: "on-chain entry token accounts", rows };
}

export interface ExportOptions {
  pool: string;
  epochId: string;
  source: string;
  table?: string | undefined;
  out: string;
}

export async function buildSnapshot(
  opts: ExportOptions,
  leaves: { owner: string; weight: bigint }[],
): Promise<{ file: SnapshotFile; tree: SnapshotTree; path: string }> {
  const entries: SnapshotEntry[] = leaves.map((l) => ({
    owner: l.owner,
    weight: l.weight,
  }));
  const tree = buildTree(entries);
  const file: SnapshotFile = {
    pool: opts.pool,
    epochId: opts.epochId,
    root: tree.root,
    totalWeight: tree.totalWeight.toString(),
    source: opts.source,
    players: entries.map((e) => ({
      owner: e.owner,
      weight: e.weight.toString(),
      proof: tree.proofs.get(e.owner) ?? [],
    })),
  };
  const payload = jsonOf(file);
  if (opts.out !== "-") fs.writeFileSync(opts.out, payload + "\n");
  return { file, tree, path: opts.out };
}

function jsonOf(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}
