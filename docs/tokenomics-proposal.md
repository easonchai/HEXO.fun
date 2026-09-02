# HexVault tokenomics and value-flow proposal

**Status: proposal, not a token launch plan.** This document turns the MinePEA reference and whiteboard concepts into explicit asset flows that can be reviewed. It does not authorize a `HEX` token, a fee, a buyback, a jackpot, a staking program, or public operation. The product requirements remain authoritative; unresolved items are marked **TBD**.

## 1. Decision this proposal resolves

The desired policy is a 6% fee on game winnings/rewards, split:

| Recipient          | Share of fee | Equivalent share of gross fee-bearing reward |
| ------------------ | -----------: | -------------------------------------------: |
| Protocol treasury  |          20% |                                         1.2% |
| HEX buyback budget |          50% |                                         3.0% |
| Pool jackpot       |          30% |                                         1.8% |

The original savings model instead makes game winnings an **Entry Token (ET)** reward. ET is non-transferable and non-redeemable by design. It cannot be held by a treasury and swapped for `HEX`, nor can it fund a jackpot paid in a pool asset. Treating ET as though it has that property would be misleading and could put principal/accounting safety at risk.

This proposal therefore separates **entry accounting** from **transferable game revenue**. No PT-backed principal, principal vault balance, or ET value is converted into a fee, jackpot, buyback, burn, or staking payment.

## 2. Proposed two-lane product model

### Lane A — core savings game

This is the no-loss-principal product:

- A user deposits a pool’s immutable accepted asset and receives matched PT and ET.
- A user spends ET on a hex-board position.
- A round can award additional ET; a 6% ET reward reduction may be burned/retired if approved.
- ET never leaves protocol accounting, has no market value, and does not create treasury, jackpot, or buyback funds.
- Prize and jackpot escrows receive only sponsor funding, separately approved realized strategy surplus, or another declared non-principal source.

This lane preserves the core savings claim. An “ET fee” is a gameplay sink, not revenue.

### Lane B — opt-in transferable-reward game

This is a separate future game product that can produce real fee revenue:

- A player explicitly opts into a game/reward whose reward is a transferable, approved asset held outside the principal vault.
- The reward is funded in advance by a sponsor, a dedicated game-reward escrow, or a separately purchased/received non-principal game allocation. It cannot be funded by deposits or PT.
- The 6% fee is assessed only when that transferable reward is settled. The player sees gross reward, fee, allocations, net reward, asset, and recipient vaults before participation and at settlement.
- The reward fee is routed atomically to dedicated treasury, buyback, and jackpot escrows for that pool.

Lane B is not a hidden variation of a savings deposit. It creates a real game cost/economic exposure and therefore requires separate terms, legal classification, player acknowledgement, audit scope, limits, and geography/eligibility approval.

## 3. Pool and asset isolation

Every pool has one immutable accepted/prize asset and its own:

- program/pool instance and configuration record;
- principal vault, ordinary prize escrow, jackpot escrow, and fee escrows;
- asset-extension policy and transfer-fee treatment;
- game/reward policy, schedule bounds, and limits;
- governing multisig, timelock, randomness provider, and version.

A token or vault cannot change after deployment. Supporting another asset—including an arbitrary SPL or Token-2022 mint—means deploying a separate isolated pool after a dedicated asset review. “No loss” means preservation of the accepted asset’s units; it never means protection from an asset’s price movement, depeg, issuer, freeze, transfer-hook, rebasing, or liquidity risk.

## 4. Exact fee arithmetic

For a transferable gross game reward `R` in the approved pool asset, use integer atomic units and basis points:

```text
F = floor(R × 600 / 10,000)              // total 6% fee
T = floor(F × 2,000 / 10,000)            // 20% of fee: treasury
B = floor(F × 5,000 / 10,000)            // 50% of fee: buyback escrow
J = F − T − B                            // 30% of fee plus indivisible dust: jackpot
N = R − F                                // player net reward
```

The system must compute and emit `R`, `F`, `T`, `B`, `J`, `N`, pool ID, asset mint, configuration version, and recipient vault addresses in the same transaction. Directing integer dust to `J` avoids unaccounted balances; this policy is immutable per configuration version.

Example: a `100.00`-unit transferable reward produces `6.00` units of fee: `1.20` treasury, `3.00` buyback budget, `1.80` jackpot, and `94.00` net player reward. The same arithmetic may **not** be represented as an asset flow when `R` is ET; the ET-only lane either burns/retires a disclosed amount or awards the configured ET reward in full.

## 5. Escrow and custody model

| Account               | Allowed sources                                                | Allowed destinations                                        | Prohibited source/destination                        |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Principal vault       | User deposits                                                  | Matched user withdrawals; separately approved strategy only | Fees, jackpots, buybacks, burns, prize settlement    |
| Ordinary prize escrow | Sponsor funding; approved realized strategy surplus            | Committed ordinary prize claims                             | Principal-vault fallback; `HEX` acquisition          |
| Jackpot escrow        | Sponsor funding; approved realized surplus; `J` fee allocation | Published jackpot claim(s)                                  | Principal, PT, ET, treasury spending                 |
| Treasury escrow       | `T` fee allocation                                             | Approved operations under multisig/timelock                 | Principal, user withdrawals, undisclosed transfers   |
| Buyback escrow        | `B` fee allocation                                             | Approved bounded market execution                           | Principal, pre-announced jackpot/prize commitments   |
| ET accounting         | Deposit/refresh/game rules                                     | Entry burn/refresh/reward accounting                        | Token swaps, external transfers, asset-prize funding |

All escrows are per pool and per asset. They are separately reconciled on-chain and in the indexer. No general-purpose administrator withdrawal is permitted.

## 6. Jackpot design

The jackpot is an independently funded, accumulating prize, inspired by MinePEA’s pot mechanic but not copied as a settled rule.

### Required properties

1. Jackpot contributions are fixed and disclosed before a qualifying round/reward begins.
2. Jackpot balance, asset, contribution history, eligibility rule, draw schedule, cap, and carryover policy are publicly queryable.
3. The draw uses a separate domain-bound, authenticated random request; it cannot reuse a manipulated game-round sample or a privileged operator choice.
4. The full jackpot amount is committed before winner selection. A payout never falls back to principal or other pool escrows.
5. Winning proof/selection, payout, expiry, and rollover are one-time transitions with public events.
6. A pool must disclose whether jackpot recipients are a single selected position, all players on a selected tile, or another fixed cohort. This cannot change after qualifying play opens.

### Open jackpot configuration

The whiteboard’s 60-second rounds, 0.1-unit pot contribution, and roughly 1-in-333 chance are useful candidate parameters only. The launch policy must choose, per pool: qualifying action, contribution amount/rate, draw cadence, winner cohort, odds formula, maximum jackpot, prize rollover, expiry, sponsor top-up, and anti-Sybil/eligibility policy.

## 7. Buyback execution controls

The buyback allocation is a **budget**, not a promise to buy or support a token price. It becomes active only after `HEX` exists and all launch gates pass.

A buyback executor must be a multisig/timelocked, constrained program or service with:

- allowlisted venues, router programs, pools, and token accounts;
- maximum spend per execution, day, pool, and governance period;
- an oracle/reference-price and maximum price-impact/slippage policy;
- a minimum delay between proposal and execution; no same-block discretionary execution;
- public input/output amounts, price, route, transaction ID, and remaining budget;
- failed-trade, stale-oracle, adverse-price, and emergency-stop behavior;
- no ability to use principal, prize, jackpot, or treasury assets outside the approved budget.

The whiteboard’s proposed downstream split is **95% of acquired HEX burned and 5% sent to an approved staking/rewards pool**. Until a tokenomics specification fixes the burn address/mechanism, accounting treatment, reward eligibility, and legal classification, acquired tokens remain in a transparent, non-spendable pending-disposition escrow.

## 8. HEX concept and demand mechanisms

`HEX` is optional. The core savings product must be useful without it. Any token launch needs an independent decision and documentation; the whiteboard’s illustrative 3,000,000 supply cap, 10,000 initial supply, five-year horizon, sell-tax concept, 90/10 burn/treasury concept, and no-lockup staking idea are **not adopted tokenomics**.

Candidate utility should be non-custodial and should not secretly convert savings principal into token demand. Options worth research include:

- cosmetic themes, board skins, and social/profile features;
- access to a separately disclosed premium game mode;
- governance only after decentralization and legal review;
- staking/reward eligibility funded only by the approved `HEX` rewards pool or real non-principal protocol revenue.

Do not launch a utility that increases a player’s ordinary prize probability, changes a random draw, bypasses limits, or provides an undisclosed return. Such mechanics are fairness, consumer-protection, and potentially securities/gambling issues before they are growth features.

## 9. Harvest and automation concept

The whiteboard’s harvest-fee/auto-miner ideas are not in scope for the core product. Any future automation must be opt-in and use a narrowly scoped authority that cannot move PT-backed principal. It needs an exact authorization, fee basis, maximum fee, expiry/revocation path, transaction previews, failure behavior, and audit. A “harvest” action cannot be used to apply an undisclosed second fee to the same reward.

## 10. Governance, disclosure, and launch gates

Before any transferable fee, jackpot, buyback, staking, or HEX feature can launch:

1. Finalize user terms, jurisdiction/eligibility, taxes, prize/game classification, and disclosures with counsel.
2. Publish asset-flow diagrams, all formulas, recipient addresses, configuration version, and historical reconciliation data.
3. Put pool configuration, fee destinations, fee rate, execution limits, and any token policy behind named multisig and timelock controls.
4. Implement authenticated production randomness plus timeout/retry/cancellation and independent review.
5. Implement durable finality-aware indexing and a user-verifiable proof/data path.
6. Add transaction-level, property, and fuzz tests for every vault/fee/jackpot/buyback state transition, asset substitution, rounding case, replay, and failure atomicity.
7. Complete an independent Solana/Anchor audit on the frozen release candidate, remediate critical/high findings, and publish the remediation matrix.
8. Complete a separate economic/tokenomics review before a `HEX` launch; it must include manipulation, liquidity, MEV, concentration, adverse-selection, and sustainability analysis.

## 11. Decisions required next

1. Choose Lane A only, Lane B only, or both. Do not implement a 20/50/30 asset allocation before this decision.
2. For Lane B, define the exact transferable reward asset and funding source: sponsor reward escrow, separately purchased game allocation, or another approved non-principal source.
3. Define the first pool asset(s), asset-approval standard, daily/weekly/monthly/custom cadence bounds, and advance-notice period.
4. Define jackpot winner cohort, schedule, odds, cap, rollover, expiry, and user disclosures.
5. Decide whether `HEX` launches. If yes, write a dedicated tokenomics PRD that resolves mint/supply/emissions, allocation/vesting, utility, execution venue, burn mechanism, staking rules, taxes, and legal analysis.

## 12. References

- `docs/product-requirements.md` — product requirements, pool architecture, and proposed 6% policy.
- `docs/protocol.md` — current technical contract, which is USDC/devnet-only and does not implement this proposal.
- `docs/research.md` — MinePEA and prize-linked-savings reference research.
- `docs/preliminary-security-review.md` — current internal findings; not an external audit.
