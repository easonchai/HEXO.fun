/**
 * PostHog for the app (docs/plan/posthog-analytics/spec.md, ADR 0015). The
 * person is the wallet pubkey; nothing here ever carries an email. Every
 * export is a no-op until `initAnalytics` has run with a `VITE_POSTHOG_KEY`,
 * so call sites never branch on whether analytics is on.
 */
import posthog from "posthog-js";

import { clusterFrom } from "./cluster.js";

type Props = Record<string, string | number | boolean | undefined>;

let enabled = false;

/** Reads `VITE_POSTHOG_KEY`; an empty or missing value means no init and no
 *  network calls. Not in `REQUIRED_IN_PRODUCTION` on purpose. */
export function initAnalytics(
  env: Record<string, string | undefined> = import.meta.env as Record<
    string,
    string | undefined
  >,
): void {
  const key = env.VITE_POSTHOG_KEY?.trim();
  if (!key) return;
  posthog.init(key, {
    api_host: "https://eu.i.posthog.com",
    defaults: "2026-05-30",
    person_profiles: "identified_only",
    // Tabs are hash routes (#vault, #referrals). The defaults' "history_change"
    // compares only the path, so a tab change would never count as a pageview.
    capture_pageview: { path: true, hash: true },
    // 100% during beta with default input masking; revisit at mainnet.
    disable_session_recording: false,
  });
  // One project for devnet and mainnet; dashboards filter on this.
  posthog.register({ cluster: clusterFrom(env) });
  enabled = true;
}

export function track(event: string, props?: Props): void {
  if (!enabled) return;
  posthog.capture(event, props);
}

/** On wallet connect. The pubkey is public on-chain data (ADR 0015). */
export function identifyWallet(pubkey: string, props?: Props): void {
  if (!enabled) return;
  posthog.identify(pubkey, props);
}

/** Invite / referral codes as person properties (ticket 04). */
export function setPersonProperties(props: Props): void {
  if (!enabled) return;
  posthog.setPersonProperties(props);
}

/** On wallet disconnect: the next connect must not inherit this person. */
export function resetIdentity(): void {
  if (!enabled) return;
  posthog.reset();
}
