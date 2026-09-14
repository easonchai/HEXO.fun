// A fake `Connection` that tallies calls per RPC method, so a suite can
// assert a ceiling instead of trusting that a poll was removed (ticket 03,
// spec.md "A shared counting connection is the new seam"). Started as the
// operator service suite's own inline `FakeConnection`
// (`getMultipleAccountsInfo` only, keyed by base58 address); this is that
// same shape, shared, with the tally added and `getAccountInfo` (the VRF
// fulfilled check, and every `getAccount`/token read that goes through it).
//
// Tickets 04 and 05 import this too: 04 to assert a send costs at most two
// calls and awaiting randomness costs none, 05 to assert the paginated sweep
// costs one call quiet and seven for a full walk. Extend it with the methods
// those need (`getProgramAccounts`, `onLogs`, ...) rather than adding a
// second counting fake.
import { PublicKey } from "@solana/web3.js";

export class CountingConnection {
  private readonly calls = new Map<string, number>();
  private readonly lastCallParams = new Map<string, unknown[]>();
  /** `context.slot` every call that reports one (e.g. `getProgramAccountsV2`) answers with. */
  slot = 100;
  /** Accounts served per `getProgramAccountsV2` page; 1,000 on the real RPC. */
  pageSize = 1_000;
  /** Addresses `onLogs`/`getSignaturesForAddress` were asked to watch or list. */
  watched: PublicKey[] = [];
  /** When set, the call whose 1-based per-method count matches throws, so a
   *  test can exercise a page (or send) failure mid-sequence. */
  failOnCallNumber: { method: string; number: number } | undefined;
  /** Answers `getProgramAccountsV2` with JSON-RPC -32601, the way a local
   *  validator and every non-Helius provider does. */
  noProgramAccountsV2 = false;

  constructor(private readonly accounts: Map<string, Buffer> = new Map()) {}

  /** Account bytes `getMultipleAccountsInfo`/`getAccountInfo` will answer with. */
  setAccount(address: PublicKey, data: Buffer): void {
    this.accounts.set(address.toBase58(), data);
  }

  deleteAccount(address: PublicKey): void {
    this.accounts.delete(address.toBase58());
  }

  /** Drops every account, e.g. to simulate an incremental result reporting
   *  nothing (a quiet sweep) or only a specific caller's next `setAccount`. */
  clearAccounts(): void {
    this.accounts.clear();
  }

  /** Calls made to `method` since construction or the last `resetCalls()`. */
  callsTo(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  /** Every tallied method at once, for a assert-the-whole-shape check. */
  callCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.calls);
  }

  /** The params the most recent call to `method` was made with, so a test
   *  can check what was asked for (e.g. `changedSinceSlot`), not just the tally. */
  lastParams(method: string): unknown[] | undefined {
    return this.lastCallParams.get(method);
  }

  resetCalls(): void {
    this.calls.clear();
    this.lastCallParams.clear();
  }

  /** Tallies the call and returns the method's new count, so a caller that
   *  wants to honour `failOnCallNumber` (`_rpcRequest` does) can reject
   *  instead of throwing synchronously out of a `Promise`-returning method. */
  private record(method: string, params?: unknown[]): number {
    const count = (this.calls.get(method) ?? 0) + 1;
    this.calls.set(method, count);
    if (params !== undefined) this.lastCallParams.set(method, params);
    return count;
  }

  getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<({ data: Buffer } | null)[]> {
    this.record("getMultipleAccountsInfo");
    return Promise.resolve(
      keys.map((key) => {
        const data = this.accounts.get(key.toBase58());
        return data ? { data } : null;
      }),
    );
  }

  getAccountInfo(key: PublicKey): Promise<{ data: Buffer } | null> {
    this.record("getAccountInfo");
    const data = this.accounts.get(key.toBase58());
    return Promise.resolve(data ? { data } : null);
  }

  getSignaturesForAddress(address: PublicKey): Promise<never[]> {
    this.record("getSignaturesForAddress");
    this.watched = [...this.watched, address];
    return Promise.resolve([]);
  }

  /** The plain call the sweep falls back to when the RPC has no V2. Always
   *  every account, in one page: that is the whole cost of the fallback. */
  getProgramAccounts(
    _programId: PublicKey,
    _config: { withContext: true },
  ): Promise<{ context: { slot: number }; value: { pubkey: PublicKey; account: { data: Buffer } }[] }> {
    this.record("getProgramAccounts");
    return Promise.resolve({
      context: { slot: this.slot },
      value: [...this.accounts.entries()].map(([pubkey, data]) => ({
        // SAFETY: keys go in through setAccount, which base58-encodes a real one.
        pubkey: new PublicKey(pubkey),
        account: { data },
      })),
    });
  }

  onLogs(address: PublicKey): number {
    this.record("onLogs");
    this.watched = [...this.watched, address];
    return 1;
  }

  removeOnLogsListener(): Promise<void> {
    this.record("removeOnLogsListener");
    return Promise.resolve();
  }

  /**
   * Stands in for web3.js's own internal JSON-RPC transport, which the
   * indexer's `getProgramAccountsV2` walk reaches into because that method
   * has no typed `Connection` API (ticket 05, probed against the Free plan:
   * pages at 1,000, keyed by `paginationKey`, honours `changedSinceSlot`).
   * Paginates `accounts` by `pageSize` and honours `paginationKey`; it does
   * not filter by `changedSinceSlot` itself, a test drives that by choosing
   * what `accounts` holds (via `setAccount`/`clearAccounts`) for the call it
   * is asserting on.
   */
  _rpcRequest(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { code?: number; message: string } }> {
    const count = this.record(method, params);
    if (this.failOnCallNumber?.method === method && this.failOnCallNumber.number === count) {
      return Promise.reject(new Error(`CountingConnection: forced failure on ${method} call ${count}`));
    }
    if (method !== "getProgramAccountsV2") {
      return Promise.reject(new Error(`CountingConnection: unexpected RPC method ${method}`));
    }
    if (this.noProgramAccountsV2) {
      return Promise.resolve({ error: { code: -32601, message: "Method not found" } });
    }
    // SAFETY: the indexer always calls this with [programId, config].
    const [, config] = params as [string, { paginationKey?: string }];
    const entries = [...this.accounts.entries()];
    const offset = config.paginationKey ? Number(config.paginationKey) : 0;
    const page = entries.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    const paginationKey = nextOffset < entries.length ? String(nextOffset) : undefined;
    return Promise.resolve({
      result: {
        context: { slot: this.slot },
        value: {
          accounts: page.map(([pubkey, data]) => ({
            pubkey,
            account: { data: [data.toString("base64"), "base64"] },
          })),
          count: page.length,
          paginationKey,
        },
      },
    });
  }
}
