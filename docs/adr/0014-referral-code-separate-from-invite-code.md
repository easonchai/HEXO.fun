# A Referral code is its own thing, separate from the Invite code

ADR 0012 had one code do two jobs: a depositor's owned Invite code let a friend past the beta
gate and, once redeemed, fixed that depositor as the friend's Referrer. That tied referrals to the
gate, and the gate goes away after the beta while referrals stay. So they are now two codes. A
Referral code is one per wallet, created at first deposit or, for a wallet past the gate that
has not deposited, on its first visit to the Referrals page, has unlimited uses, is shared as a
`?ref=` link, and does not pass the gate. An Invite code is single use and only passes the gate.
Each wallet that redeems one receives two of its own, as long as fewer than 50 unredeemed Invite
codes exist, Admin-issued ones included.

The Referrer is whoever owns the Referral code the wallet applied before its first deposit. If it
applied none, the owner of the Invite code it redeemed is used instead, so a beta invite still
earns a referral. Either way it is written once and never changed.

Applying a Referral code needs a message signature from the wallet, even though nothing moves on
chain. Wallet addresses are public and the binding is permanent, so without proof of ownership
anyone could claim every wallet that has not deposited yet as their own referral. In the gate
flow the Referral code goes inside the redeem signature the user already makes, so it adds no
extra prompt.

Considered and rejected: keeping one code and renaming it on screen. The gate's use limit then
caps a Referrer's reach, and ending the beta would mean deleting the thing referrals hang off.

Consequences: depositors' existing owned Invite codes become their Referral codes, and Referrals
already bound through them stay as they are. `docs/plan/referral-page/spec.md` has the details.
