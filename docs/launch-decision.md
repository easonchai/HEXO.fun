# Launch decision: ET-only savings game first

**Decision:** Launch the **pure ET / sponsor-funded savings game (Lane A) only.**
Do **not** build or enable the opt-in transferable-reward lane (Lane B) in the first
release. The 20/50/30 allocation is **not implemented** and must not be implemented until
Lane B exists and clears its own gates.

This resolves the developer decision recorded in `docs/tokenomics-proposal.md` §11.1.

## Why ET-only first

1. **The 20/50/30 split has no fee base without Lane B.** In Lane A, game rewards are ET —
   non-transferable, non-redeemable. A percentage of ET cannot fund a treasury, buy HEX, or
   back a prize asset. Implementing the allocation against ET would be an accounting
   fiction (tokenomics proposal §1 says exactly this).
2. **The standing directive forbids the only Lane-A fee variant.** PRD option 1 (retire/burn
   6% of ET rewards) is a burn of non-transferable ET used as a fee. That is excluded by the
   product rule that non-transferable ET is never used for fees or burns. Therefore v1
   awards game rewards **whole** — a fee would exist only to be destroyed, and destroying
   player rewards for no revenue is strictly worse than not taking it.
3. **Lane B changes the legal character of the product.** A transferable, asset-denominated
   game reward with a real user-paid fee is a different consumer product requiring its own
   terms, eligibility, classification, and audit scope (tokenomics §2, PRD §14.2). Gating
   launch on that review delays the core savings loop for no safety benefit.
4. **Lane A is complete without it.** Deposits, matched custody, rounds, prizes, jackpot
   (sponsor-funded), and rollover deliver the full product value: engaged saving with
   principal never at risk. Fee revenue is a sustainability concern, not a v1 correctness
   concern.

## What v1 does instead of the fee

- Prize escrow and jackpot escrow are funded by explicit sponsor/operator transfers
  (`fund_prize`, `fund_jackpot`) — non-principal by construction and fully event-tagged.
- Jackpot rollover is automatic (unclaimed jackpot simply stays in its escrow).
- Realized fee/jackpot economics are deferred behind Lane B's gates (below).

## Conditions to add Lane B (all required, in order)

1. Written legal/compliance classification of a user-paid game fee and transferable reward
   in target jurisdictions; eligibility and geo policy.
2. Separate tokenomics review of the 20/50/30 flows including MEV, slippage, and
   sustainability (tokenomics §10.8).
3. A distinct audited program upgrade implementing fee escrows with the exact integer
   arithmetic from tokenomics §4, atomic routing, and disclosure events.
4. Independent audit of the upgrade + remediation, per `docs/launch-checklist.md`.
5. Explicit player acknowledgement flow and UI disclosure of gross reward, fee, net reward,
   and recipient vaults before participation.

Until then, no code path in this repository may move PT-backed principal or ET into any
fee, jackpot, buyback, burn, or staking destination. The program enforces this structurally:
prize/jackpot escrows are funded only by external token-account transfers, and ET never
leaves protocol accounting.
