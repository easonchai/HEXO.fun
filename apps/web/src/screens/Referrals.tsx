/**
 * REFERRALS tab (docs/plan/hexo-referrals ticket 11): owned invite codes with
 * a copyable `?invite=CODE` share link, band progress, today's/yesterday's
 * bonus tickets, and the referral list. Placeholder UI: plain elements, no
 * Figma styling yet, same as ticket 09's AccessGate and ticket 10's Vault
 * yield/buy-tickets sections. Logic lives in referrals.ts (pure) and
 * useReferrals.ts (the poll and the copy flow); this file only reads them.
 */
import type { PublicKey } from "@solana/web3.js";

import { formatAtomic2 } from "../lib/money.js";
import { bandProgressLabel, referralStatusLabel } from "../referrals.js";
import { useReferrals } from "../useReferrals.js";

const DECIMALS = 6;
const SYMBOL = "USDC";

export interface ReferralsScreenProps {
  owner: PublicKey | null;
  onConnect: () => void;
}

export function Referrals({ owner, onConnect }: ReferralsScreenProps) {
  const referrals = useReferrals(owner?.toBase58());
  const data = referrals.data;
  const fmt2 = (atomic: string) => formatAtomic2(BigInt(atomic), DECIMALS);

  if (owner === null) {
    return (
      <div data-testid="referrals-screen">
        <section aria-label="Referrals">
          <h2>Referrals</h2>
          <p>Connect your wallet to see your referrals.</p>
          <button type="button" onClick={onConnect} data-testid="referrals-connect">
            CONNECT
          </button>
        </section>
      </div>
    );
  }

  return (
    <div data-testid="referrals-screen">
      <section data-testid="referrals-codes" aria-label="Your invite codes">
        <h2>Your invite codes</h2>
        {data && data.ownedCodes.length > 0 ? (
          <ul>
            {data.ownedCodes.map((code) => (
              <li key={code.code} data-testid={`referrals-code-${code.code}`}>
                <code>{code.code}</code>
                <span> — {code.usesLeft} uses left</span>{" "}
                <button
                  type="button"
                  onClick={() => referrals.copyLink(code.code)}
                  data-testid={`referrals-copy-${code.code}`}
                >
                  {referrals.copiedCode === code.code ? "COPIED" : "COPY LINK"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No invite codes yet. Deposit once to get one.</p>
        )}
      </section>

      <section data-testid="referrals-band" aria-label="Your band">
        <h2>Your band</h2>
        <p data-testid="referrals-band-count">{data?.qualifiedCount ?? 0} qualified referrals</p>
        <p data-testid="referrals-band-progress">
          {data
            ? bandProgressLabel(data.rateBps, data.countToNextBand, data.nextRateBps)
            : "—"}
        </p>
      </section>

      <section data-testid="referrals-bonus" aria-label="Bonus tickets">
        <h2>Bonus tickets</h2>
        <dl>
          <div>
            <dt>Today</dt>
            <dd data-testid="referrals-bonus-today">
              {data ? `${fmt2(data.bonusToday)} ${SYMBOL}` : "—"}
            </dd>
          </div>
          <div>
            <dt>Yesterday</dt>
            <dd data-testid="referrals-bonus-yesterday">
              {data ? `${fmt2(data.bonusYesterday)} ${SYMBOL}` : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section data-testid="referrals-list" aria-label="Your referrals">
        <h2>Your referrals</h2>
        {data && data.referrals.length > 0 ? (
          <ul>
            {data.referrals.map((row, index) => (
              <li key={`${row.wallet}-${index}`} data-testid={`referrals-row-${index}`}>
                <span>{row.wallet}</span>
                <span> — {referralStatusLabel(row.qualified, row.daysToQualify)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="referrals-empty">
            No referrals yet. Share your invite link above to start earning bonus tickets.
          </p>
        )}
      </section>

      {referrals.error ? <p data-testid="referrals-error">{referrals.error}</p> : null}
    </div>
  );
}
