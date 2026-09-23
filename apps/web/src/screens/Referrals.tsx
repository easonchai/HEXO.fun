/**
 * REFERRALS tab (referral-page ticket 01): the Figma "Invite Page" (`204:12137`)
 * rebuilt one card per Figma frame. This ticket only builds the hero
 * (`204:12172`) and the page shell; the row below it is where the Bonus Rate
 * (`230:16970`, ticket 03) and Referral's Bonus (`230:17196`, ticket 04)
 * cards drop in side by side, and Your Team (`204:12548`, ticket 05) and FAQ
 * (`204:12299`, ticket 06) drop in full width below that — the containers
 * and gaps are already here, the cards themselves aren't.
 *
 * Logic lives in referrals.ts (the pure hero view-model) and useReferrals.ts
 * (the poll and the copy flow); this file only reads them, mirroring
 * screens/Vault.tsx's split from useAccessGate.ts.
 */
import type { PublicKey } from "@solana/web3.js";

import { InfoTip } from "../InfoTip.js";
import { referralHeroState, type ReferralHeroState } from "../referrals.js";
import { useReferrals } from "../useReferrals.js";

export interface ReferralsScreenProps {
  owner: PublicKey | null;
  onConnect: () => void;
  /** DEPOSIT goes to EARN (spec.md Copy), never straight to the Vault widget
   *  — TABS.ts's comment on DASHBOARD: one way into the money path. */
  onDeposit: () => void;
}

/** spec.md Copy, "Hero tooltip" (Figma tooltip `230:17717`). */
const HERO_TIP = [
  "Share this code to build your crew.",
  "When friends sign up and deposit $50+, you unlock daily bonus draw tickets and a 2% win-share whenever they win.",
] as const;

export function Referrals({ owner, onConnect, onDeposit }: ReferralsScreenProps) {
  const walletKey = owner?.toBase58();
  const referrals = useReferrals(walletKey);
  const hero = referralHeroState(walletKey, referrals.data);
  const copied = hero.kind === "has-code" && referrals.copiedCode === hero.code;

  return (
    <div className="referrals-page" data-testid="referrals-screen">
      <div className="referrals-content">
        <ReferralHero
          state={hero}
          copied={copied}
          onCopy={() => {
            if (hero.kind === "has-code") referrals.copyLink(hero.code);
          }}
          onConnect={onConnect}
          onDeposit={onDeposit}
        />

        <div className="referrals-row">
          {/* Bonus Rate card (Figma 230:16970, ticket referral-page/03) drops in here, flex: 1. */}
          {/* Referral's Bonus card (Figma 230:17196, ticket referral-page/04) drops in here, flex: 1. */}
        </div>
        {/* Your Team (Figma 204:12548, ticket referral-page/05) drops in here, full width. */}
        {/* FAQ (Figma 204:12299 / 171:28875, ticket referral-page/06) drops in here, full width. */}

        {/* Disconnected always polls to "no wallet connected" (useReferrals.ts);
            the hero's own CONNECT action already says that, so only a real
            fetch failure while connected is worth a banner. */}
        {walletKey && referrals.error ? (
          <p className="screen-note err" data-testid="referrals-error">
            {referrals.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ReferralHero({
  state,
  copied,
  onCopy,
  onConnect,
  onDeposit,
}: {
  state: ReferralHeroState;
  copied: boolean;
  onCopy: () => void;
  onConnect: () => void;
  onDeposit: () => void;
}) {
  return (
    <section className="referral-hero" aria-label="Invite your crew">
      {/* Clips the background image + glow to the card's rounded corners.
          Separate from the card itself (which stays overflow: visible) so
          the InfoTip bubble below can overflow the card, per spec.md. */}
      <div className="referral-hero-bgclip" aria-hidden="true">
        <img className="referral-hero-bg" src="/referrals/hero-gift.webp" alt="" width={562} height={562} />
        <span className="referral-hero-glow" />
      </div>

      <div className="referral-hero-copy">
        <h1 className="referral-hero-title">
          We save,
          <br />
          we win.
        </h1>
        <p className="referral-hero-lead">
          Boost your daily tickets together. Earn ongoing bonus tickets on their savings plus a
          2% win-share—with zero deductions from their balance.
        </p>
      </div>

      <div className="referral-hero-stats">
        <div className="referral-stat">
          <span className="referral-stat-value">5%</span>
          <span className="referral-stat-label">Max Daily Boost</span>
        </div>
        <div className="referral-stat">
          <span className="referral-stat-value">2%</span>
          <span className="referral-stat-label">Team Win-Share</span>
        </div>
      </div>

      <div className="referral-hero-invite">
        <div className="referral-hero-invite-head">
          <h2 className="referral-hero-invite-title">Invite your crew</h2>
          <InfoTip id="referral-hero-tip" paragraphs={HERO_TIP} />
        </div>
        <div className="referral-code-field" data-testid="referral-code-field">
          {state.kind === "disconnected" ? (
            <>
              <span className="referral-code-placeholder">
                Connect your wallet to get your code
              </span>
              <button
                type="button"
                className="referral-pill-btn"
                data-testid="referrals-connect"
                onClick={onConnect}
              >
                CONNECT
              </button>
            </>
          ) : state.kind === "no-code" ? (
            <>
              <span className="referral-code-placeholder">Deposit once to get your code</span>
              <button
                type="button"
                className="referral-pill-btn"
                data-testid="referrals-deposit"
                onClick={onDeposit}
              >
                DEPOSIT
              </button>
            </>
          ) : (
            <>
              <span className="referral-code-value" data-testid="referral-code">
                {state.code}
              </span>
              <button
                type="button"
                className="referral-pill-btn"
                data-testid="referrals-copy"
                onClick={onCopy}
              >
                {copied ? "COPIED" : "COPY"}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
