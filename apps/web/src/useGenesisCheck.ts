/**
 * Ticket 14: at load, the RPC's genesis hash must match the cluster this
 * bundle was built for (`VITE_CLUSTER`); a wrong RPC URL is otherwise a
 * silent devnet-signs-on-mainnet (or the reverse) bug. `genesisMatchesCluster`
 * (cluster.ts) is the pure comparison; this just wires it to the connected
 * RPC once at mount.
 */
import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";

import { CLUSTER } from "./chain.js";
import { genesisMatchesCluster } from "./cluster.js";

/** Null while unchecked or matching; a reason string once a mismatch is
 *  confirmed. A failed genesis read (RPC down) is not itself a mismatch —
 *  that already shows up as the state poll's own error banner. */
export function useGenesisCheck(connection: Connection): string | null {
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void connection
      .getGenesisHash()
      .then((hash) => {
        if (cancelled) return;
        setReason(
          genesisMatchesCluster(hash, CLUSTER)
            ? null
            : `RPC genesis hash does not match VITE_CLUSTER=${CLUSTER}; refusing to sign against the wrong network.`,
        );
      })
      .catch(() => {
        // Leave it unset: a stuttering RPC is not a confirmed mismatch.
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  return reason;
}
