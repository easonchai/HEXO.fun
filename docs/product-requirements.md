# HexVault product requirements document

**Document status:** product definition

**Purpose:** define the intended HexVault product independently of the repository’s current implementation. This is not an implementation contract, audit report, launch approval, yield promise, or legal opinion. Where a commercial, policy, or economic choice has not been supplied, it is explicitly marked **TBD** rather than invented.

## 1. Product summary

HexVault is an active prize-linked savings experience on Solana. A user deposits the accepted asset for a specific pool, retains a 1:1 claim in units of that asset, and receives a separate, non-transferable game-entry balance for the current season. They can use entries to select hex-board positions in short game rounds. Game results can improve a player’s seasonal prize weight, while each pool’s prize is funded only by sponsor funding, realized strategy surplus, or an approved non-principal game-revenue source—not by user principal.

USDC weekly pools are the initial product reference. The intended product architecture supports separately deployed pools with their own fixed accepted asset and configurable season cadence; it must never imply that preserving a volatile asset’s units preserves its market value.

The product combines the familiar engagement of a game board with the safety property users care about: **game play must never directly spend, transfer, or fund a prize from accounted principal.** Spending an entry can temporarily reduce how much of the matching principal is immediately withdrawable; this is a material rule and must be explained before a player enters a round.

## 2. Problem and opportunity

Traditional savings products are passive and provide little engagement. Conventional on-chain games are engaging but typically require users to risk the staked asset. HexVault aims to make saving participatory without presenting a user’s deposited principal as the wager.

The product should make three things simultaneously true:

1. A user can understand what they deposited, what remains immediately withdrawable, and why.
2. A user can play a simple, transparent game without confusing game entries for money or a guaranteed return.
3. A prize is visibly and technically separate from customer principal.

## 3. Product principles

1. **Principal is not the prize pool.** Prize payments never debit the principal custody balance.
2. **Truthful UX over promotional UX.** No “risk-free,” guaranteed APY, guaranteed prize, or misleading probability claims. But it is a gamified UX, which makes people wanna play, just we dont lie about stats.
3. **Game balance is not money.** Entries cannot be transferred, sold, redeemed, or represented as the pool asset.
4. **Explain consequences before confirmation.** A player sees the exact entry cost and resulting immediately withdrawable principal before buying a position.
5. **On-chain state is authoritative.** The UI, indexer, animations, and notifications may explain state but cannot decide balances, winners, or settlement.
6. **Graceful safety.** A safety pause stops new risk-taking actions but must preserve the documented withdrawal route whenever technically possible.
7. **Progressive decentralization only with controls.** Product convenience never justifies a custodial wallet, a hidden authority, or unrestricted administrator powers.

## 4. Audience and primary jobs

### Target user: engaged stablecoin saver

A Solana wallet user with an accepted pool asset—initially USDC—who wants a more engaging way to save than simply holding it. They want to retain visibility into their balance and to understand the downside of game choices.

**Jobs to be done**

- “Help me deposit savings while retaining a clear claim on the pool asset I deposited.”
- “Let me participate in a short, understandable game without treating my deposit as a casino wager.”
- “Show me my current withdrawal capacity, seasonal entries, round outcomes, and prize eligibility.”
- “Let me withdraw the amount I am entitled to without a support request or operator approval.”

### Target user: game participant

A user motivated by the hex-board interaction and weekly prize drawing. They need a clear explanation of tile selection, per-tile entry cost, round close time, randomness, outcomes, and how game rewards affect prize weight.

### Operator: protocol operations team

An accountable team responsible for funding prizes, publishing operational status, handling incidents, and maintaining regulated-market controls. Operators need bounded authority, auditable actions, monitoring, and a way to stop new risk-taking actions without taking custody of withdrawals.

## 5. Product scope

### In scope

- Non-custodial Solana wallet connection and transaction signing.
- Deposit and withdrawal experience for the immutable accepted asset of a selected pool; USDC is the initial reference asset.
- Separate principal and seasonal-entry accounting.
- Daily, weekly, monthly, or custom-duration seasons (epochs), a 36-tile hex board, and multiple time-bounded rounds per season.
- Separate jackpot escrow, an approved game-revenue fee model, and transparent prize/jackpot funding accounting.
- One immutable board position per wallet per round; a position can cover one or more tiles at one uniform entry amount per tile.
- Authenticated, verifiable randomness for round results and the weekly prize selection.
- Prize eligibility based on a published, reproducible seasonal-entry snapshot.
- Sponsor-funded and, only after separate approval, realized-yield-funded prize escrow.
- Player history, transaction status, round results, prize status, disclosures, and support/incident status.

### Explicitly out of scope

- Custody of user private keys or automatic signing on a user’s behalf.
- Transferable, tradable, redeemable, or governance-valued entry tokens.
- Any claim that a deposited asset, lending strategy, prize, jackpot, or token is free of economic, smart-contract, market, liquidity, or regulatory risk.
- Depositing principal in a third-party yield strategy before the strategy passes its separate governance, risk, legal, and audit gates.
- A prize that draws from principal, a negative principal balance, or a loss-recovery promise.
- Geographic availability or regulated-market access before legal and compliance approval.

## 5A. Multi-pool, asset, and schedule architecture

### Pool isolation and accepted assets

A **pool** is an isolated product instance defined by one accepted deposit/prize asset, principal vault, prize escrow, jackpot escrow, game rules, and cadence policy. Its accepted mint, token program, decimals, transfer-fee/extension policy, and vault identities are immutable after deployment. Changing the asset, token-program policy, or vaults means deploying a new program/pool instance; it is never an administrator configuration update.

The product direction permits future pools for arbitrary assets, but “arbitrary” does not mean that an unknown mint may be substituted at runtime. Each asset/pool deployment must have a published asset profile and pass its own risk and technical review, including mint authority, freeze authority, transfer hooks/fees, interest-bearing or rebasing behavior, token extensions, liquidity, oracle availability, legal treatment, and strategy compatibility. Principal conservation is measured in units of the accepted asset, not in USD value. The no-loss-principal proposition is initially suitable only for assets whose unit and redemption risks are explicitly understood; it cannot promise protection from a volatile asset’s price movement, depeg, issuer action, or token-program behavior.

### Configurable cadence without retroactive rule changes

Each pool supports a parameterized epoch schedule: daily, weekly, monthly, or a bounded custom duration. The schedule may change over the product’s life, but the following rules are mandatory:

1. An epoch’s start, play cutoff, snapshot time, randomness window, claim deadline, and reward/jackpot rules become immutable before that epoch opens.
2. A timing change can affect only a future, not-yet-created epoch. It cannot shorten or extend an open epoch, change an in-progress round, move an announced snapshot, or alter a pending claim deadline.
3. Every schedule change is queued through multisig and timelock, has a public effective epoch ID and human-readable UTC schedule, and provides a minimum user-notice period **TBD** by pool duration.
4. Custom durations have governance-configured minimum/maximum bounds, closing buffers, and maximum claim windows. The bounds and an epoch’s full schedule are visible before any deposit or position is made.
5. A pool’s cadence change cannot modify the accepted asset, vaults, fee destination, existing prize commitment, or current users’ withdrawal entitlement.

This lets the product learn across daily, weekly, and monthly pools without creating an operator ability to manipulate an active game or savings period.

### Pool configuration record

Before a pool accepts deposits, it publishes an immutable or timelocked configuration record containing: accepted mint and token program; asset-risk disclosure; principal/prize/jackpot vaults; epoch-duration bounds; active schedule; game-round bounds; entry/reward caps; fee policy; jackpot policy; randomness provider; role/multisig addresses; and the program version. The client must render the record and require a user acknowledgement when an asset or material policy changes.

## 6. Core product model

### 6.1 Balances

| Balance                          | Meaning                                        | User action                                                                     | Transferability                     |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| USDC deposited                   | User funds held for their principal claim      | Deposit / withdraw                                                              | USDC is standard token balance      |
| Principal balance (PT)           | 1:1 accounting claim on deposited USDC         | Created on deposit; burned on withdrawal                                        | Non-transferable                    |
| Entry balance (ET)               | Current-season game and prize-weight balance   | Created on deposit/season refresh; spent on positions; can be earned from games | Non-transferable and non-redeemable |
| Immediately withdrawable balance | The portion backed by both PT and available ET | Withdraw                                                                        | Not a separate token                |
| Prize escrow                     | USDC reserved for prizes                       | Claimed only by selected eligible winner                                        | Not user principal                  |

The product displays values in USDC units with six decimal precision internally and user-friendly decimal formatting externally. It must not use floating-point display or calculation for settlement values.

### 6.2 Deposit

1. The user connects a supported non-custodial Solana wallet.
2. The user selects a USDC amount at or above the published minimum.
3. Before signing, the UI shows deposited USDC, PT created, ET created or timing of its availability, applicable fees (**TBD**), and risks.
4. After confirmed settlement, the UI shows the updated principal balance, available entries, immediately withdrawable amount, and transaction link.

**Product requirement:** a successful deposit creates equal principal and entry value for an open season. If a deposit occurs after the season’s eligibility cutoff, the UI must state whether entries apply to the current or next season before confirmation.

### 6.3 Withdrawal

A user requests an amount up to the lesser of their principal and available-entry balances. The product must display this limit continuously.

Before a withdrawal signature, the UI shows:

- requested USDC;
- principal balance before and after;
- entry balance before and after;
- immediately withdrawable amount before and after;
- whether an entry refresh is required and when it becomes available;
- network fee and any product fee (**TBD**).

A withdrawal cannot require manual approval, access to prize escrow, or an operator action. If a safety pause is active, the UI must explain its scope and keep the available withdrawal action visible.

### 6.4 Configurable pool season

A production pool may use a daily, weekly, monthly, or bounded custom UTC season. The applicable pool configuration fixes the duration and all material timestamps before an epoch opens; a change may apply only to a future epoch as defined in [configurable cadence](#configurable-cadence-without-retroactive-rule-changes). Product operations publishes the deposit/entry cutoff, final game-round cutoff, snapshot time, drawing time, and claim deadline. All dates appear in the user’s local timezone and UTC.

At season rollover, each player’s ET is set to their current PT balance after prize eligibility is finalized. This restores withdrawal capacity for principal whose entries were spent during the prior season and expires any game-earned entry advantage after it has served its seasonal purpose.

The product must show a timeline and status for the current and next season:

- Open for deposit/play
- Game rounds closing
- Snapshot in progress/finalized
- Randomness pending/finalized
- Prize claim open
- Prize claimed/expired
- Entries refreshed for the new season

### 6.5 Hex-board rounds

A game round contains exactly 36 visually distinct hex tiles. For each available round, the player can:

1. Review start/close time, available entries, per-tile entry range, and the round’s game-entry reward.
2. Select one or more tiles and one entry amount per selected tile.
3. See total entries spent and revised immediate withdrawal capacity before confirming.
4. Submit one immutable position for that round.
5. Observe a published randomness result, winning tile, their result, and any earned ET.

Rules:

- A wallet submits at most one position per round.
- Position changes, cancellation, top-up, and duplicate purchase are unavailable after submission.
- Entries spent on non-winning tiles do not return during the season.
- A winning position receives a proportional allocation of that round’s configured ET reward based only on stake placed on the winning tile.
- Game rewards are ET only; they never mint principal or transfer USDC.
- The UI must use language such as “entries spent” and “seasonal reward,” never “bet,” “wager,” “cash-out,” or an equivalent unapproved term without legal review.

### 6.6 Prize drawing and claim

At the season snapshot, the system commits the eligible ET weights and the prize amount. After an authenticated randomness result, one weight interval is selected without modulo bias. A selected user may claim the already-committed prize from separate prize escrow before the claim deadline.

The product must provide:

- prize amount and funding source disclosure (sponsor, realized strategy surplus, or both);
- snapshot timestamp, total eligible weight, and a way to verify a user’s inclusion and weight;
- randomness provider, request/result identifiers, and verification status;
- selected prize state, claim deadline, and transaction status;
- a public season archive of winner status, prize paid, or prize expiry;
- no public disclosure of a winner’s personal identity beyond their wallet unless they opt in.

The prize amount and payout policy for an unclaimed prize are **TBD** and must be finalized with legal/compliance review before public launch.

### 6.7 Jackpot and game-fee policy

Each pool may operate a separate jackpot escrow in its accepted prize asset. Jackpot escrow is distinct from the principal vault, ordinary prize escrow, ET balances, and any future HEX treasury. It may receive a combination of disclosed sponsor funding, realized strategy surplus after separate approval, and approved non-principal game revenue. It must never receive principal, PT, or a transfer of non-transferable ET represented as if it were a redeemable asset.

The proposed fee policy is a **6% fee on game winnings/rewards only**, never on a principal deposit or withdrawal. The intended allocation of that 6% is 20% protocol treasury, 50% HEX buyback, and 30% jackpot—equivalent to 1.2%, 3.0%, and 1.8% respectively of a fee-bearing gross game reward. All amounts, recipient vaults, and the effective policy version must be shown before a player enters a round.

There is a necessary design decision before that allocation can fund a real treasury, buyback, or asset jackpot: under the core model ET is non-transferable and non-redeemable. Retaining 6% of an ET reward can reduce or burn the player’s ET reward, but ET cannot be swapped to buy HEX and cannot fund a prize asset. Therefore the product must choose and disclose one of these models before launch:

1. **Entry-only model:** take the 6% in ET, retire/burn it, and treat the treasury/buyback/jackpot percentages as inapplicable. This preserves the pure savings-entry model but produces no transferable revenue.
2. **Non-principal game-revenue model:** charge or receive the 6% in a separately transferred, approved pool asset only for the game action/reward—not from the user’s principal deposit or PT-backed vault. The fee is sent atomically into fee escrow and allocated 20/50/30 into treasury, buyback, and jackpot escrows. This introduces a real user-paid game cost and requires distinct product wording, risk disclosure, and legal review.
3. **Sponsor/revenue-funded model:** leave ET rewards whole, and allocate an independently funded sponsor/protocol-revenue stream using the 20/50/30 split. This avoids a user-paid game fee but requires an external funding source.

The MinePEA-inspired jackpot mechanic is a future premium-game reference: a fixed, pre-announced portion of each eligible game round/revenue stream contributes to a jackpot; a verifiable, independent draw selects the jackpot outcome; and the rules state whether the prize goes to one selected position, eligible players on a selected tile, or another published cohort. The whiteboard’s 60-second round and 1-in-333 example are concepts, not adopted odds or a launch promise. Jackpot contribution rate, draw frequency, eligibility, rollover, cap, and unclaimed-prize policy are per-pool configuration decisions requiring legal, economics, and security approval.

## 7. Functional requirements

### 7.1 Wallet, account, and transaction experience

- Support the approved standard Solana wallet connections; embedded-wallet support is optional and must remain non-custodial.
- Require a wallet signature for every fund-moving or position-changing action.
- Simulate/signpost transaction requirements where available and clearly report rejected, failed, pending, confirmed, and finalized states.
- Make every relevant transaction accessible through a configured Solana explorer.
- Never collect, transmit, or store a user’s seed phrase or private key.
- Reconcile the UI from finalized on-chain state after refresh, reconnect, or transaction confirmation.

### 7.2 Dashboard

The default dashboard shows:

- deposited principal in the selected pool asset, available entries, and immediately withdrawable amount;
- current season status/countdown, ordinary prize amount, and jackpot amount/status where enabled;
- active/recent rounds, active position, and next action;
- recent deposits, withdrawals, game positions, ET rewards, and prize events;
- safety/pause status and a visible risk/disclosure link.

### 7.3 Notifications

The product offers in-app status notifications for transaction results, round close, round settlement, entry refresh availability, prize selection, and prize-claim deadline. Email/push/third-party messaging is **TBD**, opt-in only, and cannot contain a private key or imply a guaranteed reward.

### 7.4 Transparency and support

- Publish current program ID, verified program build, role addresses, protocol version, and system status.
- Publish historical prize funding, prize commitments, claims/expiry, and season status in a queryable public view.
- Provide a clear incident/status page and responsible-security-disclosure route.
- Explain all product terms in plain language: principal, entries, immediate withdrawal capacity, snapshot, random selection, prize escrow, and strategy risk.

## 8. Security, controls, and operational requirements

These are product requirements, not optional implementation details.

1. Aggregate accounted principal must be fully backed by separately held principal custody assets, subject to disclosed strategy risk only after an approved strategy launch.
2. Prize payment must be limited to segregated prize escrow and must never fall back to principal custody.
3. Principal and entry balances must be non-transferable and modifiable only by authorized protocol logic.
4. Randomness callbacks must be authenticated, bound to the particular game/prize request, unbiased, consumed once, and recoverable through documented timeout/retry handling.
5. Every privileged role must be held by a named multisig; parameter changes, upgrades, and snapshot-root publication require a documented timelock and public change record.
6. The game, prize, and transaction service must be monitored for failed settlement, stale indexer state, unexpected supply/vault deltas, and callback failures.
7. A guardian may stop new deposits and positions, but cannot move funds or prevent documented ordinary withdrawals.
8. The indexer must process finalized chain state, persist a replayable cursor, survive restarts, and expose reconciliation tooling.
9. A user must be able to independently verify their prize eligibility proof and transaction result from published data.
10. All external integrations—including RPC, randomness, yield, wallet, analytics, and notifications—require vendor, privacy, incident, and dependency review.
11. Asset mint, token program, vault identities, and an open epoch’s material dates/rules are immutable at the required scope. A timing policy may change only for a publicly announced future epoch through multisig/timelock.
12. Principal, PT, and non-transferable ET cannot be used for fees, jackpot funding, treasury proceeds, HEX acquisition, burns, or staking yield. Every fee/jackpot transfer uses its own configured escrow and must be reconcilable on-chain.
13. A multi-asset deployment rejects a token-account, mint, token-program, extension, or price/risk assumption that is not explicitly approved for that pool.

## 9. Yield and prize funding policy

Initial public operation uses disclosed sponsor funding in a dedicated prize escrow. Yield is not a prerequisite for the product’s core behavior.

A future yield strategy may fund prizes only after it has separate approval for strategy selection, caps, withdrawal liquidity, oracle/slippage protections, emergency unwind, loss handling, audit, monitoring, and user disclosure. The product must display realized net funding, not a projected APY, and must state that strategy outcomes can be variable or negative.

The source and amount of each prize must be finalized before prize eligibility is committed.

## 10. Future HEX utility and token-economy exploration

`HEX` is a future optional utility-token concept, not a deployed asset, financial promise, or prerequisite for the core savings product. Its mint address, supply, emissions, distribution, governance rights, transfer restrictions, and launch decision are all **TBD**. The product must not advertise a buyback, burn, staking yield, price-support mechanism, return, or supply-reduction promise until a separate tokenomics specification, legal assessment, security review, and governance approval exist.

The whiteboard informs the following concepts to investigate, not commitments:

- Directing an approved share of real, non-principal game revenue to market buybacks, with a proposed 50% of the 6% game-reward fee allocation; a proposed split of acquired HEX is 95% burn and 5% staking/rewards pool.
- Directing 20% of that fee allocation to a transparent protocol treasury and 30% to the relevant pool’s jackpot escrow.
- Creating demand through optional, non-custodial utility such as cosmetic board themes, non-financial account/profile features, or separately priced premium game modes. Any utility that changes prize probability, entry access, or payout needs explicit fairness and legal review.
- Exploring a capped staking mechanism that may share only approved protocol revenue. “No lockup,” emission schedules, an initial supply, a long-term supply cap, sell taxes, and any fee-sharing structure are **TBD**; the whiteboard’s illustrative 3,000,000 cap, 10,000 initial supply, five-year schedule, 90/10 burn/treasury concepts, and fee ideas are not product commitments.
- Evaluating a harvest/automation feature only if the user explicitly authorizes it, its fee is separate and visible, it cannot access principal without a signature or pre-approved limited delegation, and it has security/legal review. The whiteboard’s harvest and auto-miner fees are exploratory only.

Before adding HEX, HexVault must publish a separate tokenomics PRD that specifies utility, asset flows, exact formulae, treasury custody, market/execution limits, MEV/slippage controls, price/oracle assumptions, staking eligibility, tax implications, jurisdictional analysis, and a model showing that no PT-backed principal or ET value is converted into HEX.

## 11. UX and accessibility requirements

- Meet WCAG 2.2 AA for the web experience, including keyboard board selection, visible focus, sufficient contrast, non-color result cues, screen-reader labels for all tiles, and reduced-motion support for orb/result animation.
- Make the 36-tile board understandable on mobile and desktop. Tile numbers, selection state, selected amount, and winning state must not depend only on shape, color, or animation.
- Never bury immediate-withdrawal consequences in a tooltip. Present them in the position confirmation flow.
- Use clear loading, disabled, error, and retry states for RPC/network problems.
- Ensure animations are cosmetic; the finalized on-chain result is the source of truth.
- Treat wallet addresses as sensitive user data in analytics and screenshots; minimize collection and provide an accessible privacy notice.

## 12. Success measures

Metrics are measured only after a legally approved public launch. Baselines and targets are **TBD**.

### User value

- Percentage of connected users completing a first deposit.
- Percentage of depositors who can accurately identify their immediately withdrawable balance in usability testing.
- Time to successful deposit, position, and withdrawal.
- Repeat participation across seasons without an increase in support contacts about withdrawal capacity.

### Trust and reliability

- Successful finalized transaction rate by action type.
- Time from round close to verified settlement; time from prize selection to claim availability.
- Indexer reconciliation mismatch count and duration.
- Failed or delayed randomness callback count.
- Security incidents, paused hours, and time to user-facing status communication.

### Sustainability

- Prize funding source mix and realized net funding.
- Cost per active saver/season.
- Support volume, accessibility issue rate, and user comprehension of material risks.

No growth or engagement metric may be used to relax custody, disclosure, accessibility, or compliance requirements.

## 13. Phased release criteria

### Phase 0 — local product validation

- Local validator flow demonstrates deposits, matched withdrawal, entry spending, and prize escrow segregation.
- Usability prototype validates dashboard, board, and withdrawal-capacity comprehension.
- No real assets, public prize offer, or yield claim.

### Phase 1 — closed devnet experience

- Functional web UI connected to a localnet/devnet program and test wallets.
- Test-only/simulated prizes clearly labeled as such.
- Transaction history, error handling, accessibility review, and support/status channel.
- Security regression coverage for every fund-moving and privileged instruction.

### Phase 2 — public testnet/beta decision

- Production-candidate randomness integration, durable indexer, observability, multisig/timelock, incident runbook, and reproducible build.
- Independent security audit and remediation completed for the frozen release candidate.
- Legal/compliance review approves wording, geography, eligibility, prize terms, and disclosures.
- No mainnet funds until all release gates have written approval.

### Phase 3 — limited mainnet launch

- Approved multisig/timelock controls and deployment ceremony complete.
- Principal and prize funding policies published; no yield strategy unless separately approved.
- External monitoring, on-call ownership, incident communication, responsible disclosure, and bug bounty active.
- A limited, disclosed launch cap and eligibility policy are approved (**TBD**).

## 14. Open decisions

The following must be decided by product, legal/compliance, risk, and engineering owners before public launch:

1. Jurisdictions, user eligibility, age/KYC/geo requirements, and the approved legal classification of prizes and the game.
2. Prize schedule, prize amount, sponsor terms, jackpot policy, unclaimed-prize treatment, and tax reporting responsibilities. The proposed 6% game-reward fee and 20/50/30 split need an approved transferable-asset funding model before they can fund real treasury/buyback/jackpot assets.
3. Minimum deposit, maximum deposit, position-entry limits, reward cap, and anti-abuse/Sybil policy.
4. Chosen authenticated SVM randomness provider, fallback policy, service-level objective, and cost model.
5. Snapshot publication/challenge model and the ownership/control model for indexer data.
6. Multisig members, timelock length, emergency authority, upgrade policy, and public change-management process.
7. Whether/when to activate yield; strategy risk limits, loss policy, and emergency unwind behavior.
8. Supported wallets, regional availability, analytics providers, privacy retention, and notification channels.
9. Brand terms and user-facing language after legal review.
10. Per-pool asset-approval policy, cadence bounds, user-notice period, and whether daily/weekly/monthly/custom pools launch together or sequentially.
11. Whether HEX launches at all; if so, its utility, mint/supply/emission policy, allocation, market-execution controls, staking terms, tax treatment, and applicable legal classification.

## 15. References

- `docs/protocol.md` — technical state machine and accounting invariants.
- `docs/security.md` — security controls and mainnet gates.
- `docs/research.md` — product references and integration research.
- `docs/tokenomics-proposal.md` — proposed fee, jackpot, buyback, and HEX value flows; not an approved token launch.
- `docs/preliminary-security-review.md` — current internal review findings; not an external audit.
- `docs/maintenance.md` — contributor and operational workflow.
