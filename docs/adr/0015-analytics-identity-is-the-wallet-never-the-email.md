# Analytics identity is the wallet pubkey, never linked to the waitlist email

The landing page and the app share one PostHog project but hold two unrelated populations. On the
landing a person is the waitlist row UUID with an email attached. In the app a person is the
wallet pubkey, the same key every backend table already uses. No alias, no shared query
parameter, no backend join ever connects the two.

The full funnel from waitlist signup to first deposit was on the table. It needs one of two
things: an alias in PostHog between the waitlist UUID and the wallet, or an invite code that
records the email it was issued to so the join can be done later. Either way an analytics SaaS
ends up holding email-to-wallet pairs for a product where the wallet holds money. A pubkey on
its own is public data and already visible in every deposit transaction; paired with an email it
identifies a person and their balance. Once an alias lands in PostHog it cannot be cleanly undone.

So the funnel stops at the Invite gate on purpose. Waitlist-to-deposit conversion, when it is
asked for, is counted offline: we hand out invite codes, so we hold the code-to-email mapping
ourselves and can join it against `InviteRedemption` rows without the pair ever leaving our own
database.

Considered and rejected: hashing the pubkey before identify. It hides nothing useful (the hash
is still stable per wallet) and costs the ability to look up a specific user's session when they
report a problem.

Consequences: PostHog dashboards for the landing and the app are separate. Anyone adding
`posthog.alias`, an email person property in the app, or a wallet property on the landing is
reversing this decision and should write a new ADR. `docs/plan/posthog-analytics/spec.md` has
the event list.
