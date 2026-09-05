// The operator reads Postgres, not the RPC, for anything that needs a list of
// accounts (spec §3.3). The indexer module owns those queries; this token
// keeps the two modules from importing each other, so either can land first.
export const INDEXER_QUERIES = Symbol("INDEXER_QUERIES");

export interface IndexerQueries {
  /**
   * Owners (base58) of Players that still need `register` for an ended epoch.
   *
   * Must exclude players whose computed weight for that epoch is zero: the
   * program treats `register` with zero weight as a no-op that leaves
   * `reg_epoch` alone, so returning one (the House, most often) makes the
   * operator resend `register` forever and never fund or close the epoch.
   */
  playersToRegister(epochId: bigint): Promise<string[]>;
  /**
   * Positions still on chain whose Round has reached a terminal status
   * (Settled, Forfeited, Voided), across every such Round, with the Round id
   * so the operator can group a batch by Round.
   */
  unsettledPositions(): Promise<{ address: string; owner: string; roundId: bigint }[]>;
}
