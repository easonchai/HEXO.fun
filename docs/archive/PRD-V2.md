# HEXO.fun product requirements (v2)

Status: draft for agreement, September 2026. Supersedes the HexVault requirements of September 2026. Everything in that document that is not changed here still stands; unchanged sections are marked. Vocabulary follows `CONTEXT.md` (Principal, Entries, epoch, jackpot, House) with one addition: **Yield** is the USDC the pool earns. Open decisions are collected in section 12 and are the only things in this document not yet agreed.

Naming: the product is HEXO.fun and the token is HEXO. The old document said HexVault and HEX; `CONTEXT.md` should be updated to match.

## 1. What it is

HEXO.fun is a prize-linked savings app where you play to boost your chances of winning prizes in a no-loss lottery pool.

Four layers, each one optional for the user above it:

1. **Save.** Deposit USDC. Principal is never at risk. It earns a base yield, paid every week, withdrawable any week.
2. **Draw.** Everything the pool earns above the base yield becomes that week's prize. One depositor wins the whole thing. Odds are time-weighted Entries.
3. **Play.** Entries are also chips on the 36-tile hex board. Every 60 seconds a round moves Entries from losers to winners. Win rounds and you carry more weight into the draw. Lose and your Principal is untouched.
4. **Token.** Rounds emit HEXO. Stake it to earn a share of protocol fees. Sell it and 10% is taxed back into the system.

A depositor who never plays still earns the base yield and still holds draw odds from the weekly Entries reset. A depositor who plays is buying draw odds with Entries, never with Principal.

## 2. Who it is for

Design reference, not marketing copy. The user is working or middle class with small savings and high commitments. They buy 4D or a lottery ticket most weeks and lose the ticket money most weeks. They keep the rest in a fixed deposit at ~3% and resent the lock. They tried crypto once, lost money on memecoins, and now want upside with no downside. Not a degen, not an aunty. Every screen should be judged against this person.

## 3. The loop

1. Connect a wallet. Privy embedded wallet by default; Phantom and friends via the standard adapter. *(unchanged)*
2. Fund. Devnet: in-app faucet. Mainnet: USDC in the wallet, or swap from SOL in-app via Jupiter.
3. Deposit. Receive equal Principal and Entries.
4. Play rounds, or don't. Stake Entries on tiles, collect round rewards as Entries and HEXO.
5. Epoch ends. The operator pays base yield to every depositor, funds the jackpot with the excess, registers weight, draws with ORAO VRF, and pushes the prize to the winner. Emitted HEXO is claimable at any time.
6. New epoch. Entries reset to Principal (including any auto-compounded yield). Play again, stake HEXO, or withdraw.

## 4. Money model

This section is new. It replaces "3.4 Simulated yield" in the old document.

### 4.1 Yield source

- The pool deploys Principal through a single **yield adapter** behind one funding instruction. The program does not care what the adapter is; the adapter's only job is to return USDC to the pool.
- Mainnet adapter: Kamino USDC lending (K-Lend main market). Kamino is the largest onchain USDC yield venue on Solana and has paid roughly 4–9% APY through 2026 depending on borrow demand. Curated Kamino vaults and multi-venue routing ("best rate" aggregation) are roadmap, not launch: at sub-$1M TVL the spread between venues does not pay for the extra contract surface.
- Devnet adapter: simulated at a published rate, labelled "simulated" everywhere it appears. *(unchanged behaviour, now framed as an adapter)*
- The adapter also harvests **incentives**: KMNO season rewards and any integrator revenue share from Kamino BuildKit accrue to the pool's position and are converted to USDC as part of gross yield. Jupiter referral fees from in-app swaps are routed to the same place.
- Principal is withdrawable at all times. The adapter must keep enough liquid buffer that a withdrawal never waits on a lending-market unwind; the target buffer is set on the pool by the authority and shown on the status screen.

### 4.2 The yield waterfall (per epoch)

Let `G` be gross USDC yield realised for the epoch (adapter yield plus harvested incentives).

1. **Base yield.** `B = total_principal × base_rate × epoch_seconds / 365 days`. `base_rate` is a published pool parameter; launch target ~4%. It is a floor the pool aims to clear, not a guarantee, and the UI never calls it one.
   - If `G ≥ B`, every depositor is credited their pro-rata share of `B` by time-weighted Principal.
   - If `G < B`, the shortfall is paid from the **reserve** (4.3). If the reserve is empty, depositors receive `G` pro-rata and `base_rate` for the next epoch is lowered and announced before it starts. Principal is never touched.
2. **Excess.** `E = G − B` (zero if negative). Split:
   - 90% → jackpot vault. This is the week's prize.
   - 10% → **buyback stream**: converted to HEXO over the following epoch (6.5), then 62.5% burnt and 37.5% sent to the staking-yield account.
3. **Reserve top-up.** *(proposed, see 12)* Before the 90/10 split, 5% of `E` goes to the reserve until it holds two epochs of `B` at the current `base_rate`.
4. **Protocol fee.** *(proposed, see 12)* Before the 90/10 split, 10% of `E` goes to the treasury account.

Principal delegated to the sponsorship address (4.5) earns no base yield; its full share of `G` goes straight to `E`.

### 4.3 Reserve

An onchain USDC account owned by the pool. Its only outflows are base-yield shortfalls under 4.2. Its balance and target are shown on the status screen. At launch it is seeded from the treasury.

### 4.4 Base yield payment

- Credited at epoch close, before the draw.
- Default: **auto-compound.** The credit is added to Principal, which mints matching Entries for the new epoch. This is how "your money earns from day one and your odds grow with it" is true.
- Alternative, per user: **pay to wallet.** The credit is pushed to the user's USDC account.
- Either way the Vault screen shows yield earned this epoch, yield earned to date, and the current `base_rate` with its "floor, not guarantee" note.

### 4.5 Delegation and sponsorship

There is no separate sponsor deposit type. Every Player account has a `delegate` field, default self. Entries always belong to the owner; weight always accrues to the delegate. Sponsorship is delegation to a fixed **sponsorship address**.

- **Delegate to another Player.** Your Entries stay yours (you can still play, still withdraw under the normal rule) but the weight they earn is credited to the delegate's Player, and the prize, if won, is paid to the delegate's owner wallet. You keep your base yield. Use: a community, an influencer, a company pooling odds for its members.
- **Delegate to the sponsorship address.** Your weight is excluded from the draw entirely and you forfeit base yield: your Principal's full share of `G` goes to `E`. Your Principal is still in the same vault, deployed through the same adapter, withdrawable under the same rule. Use: treasury, investors, and partner brands making the prize larger than the user pool alone can fund. This is the single biggest lever on prize size before TVL is real.
- `set_delegate` settles weight accrued so far to the current delegate, then switches. Weight already earned this epoch stays where it was earned. Only the owner can call it. The target must have a Player account; the sponsorship address is initialised by the pool authority.
- Base yield `B` is computed on total Principal minus Principal delegated to the sponsorship address. Total draw weight is the sum over all Players except the sponsorship address.
- Registration at epoch close registers weight under the delegate's Player, so a delegate with zero Principal (a community account) is a valid winner.
- Sponsor Principal and its share of this week's prize are shown on the weekly draw screen as "boosted by sponsors". Delegation is permissionless; the sponsorship preset is one click.

### 4.6 The House

*(replaces 3.6 in the old document)*

- The House is a Player account owned by the pool authority. It has no Principal.
- It receives forfeited round pots and the round fee (5.4) as Entries, and competes in the draw with the weight those Entries earn. Its Entries reset to zero each epoch.
- If the House wins the jackpot: **20% → treasury, 80% → buyback** (then 62.5% burnt, 37.5% to staking yield). All accounts onchain and inspectable.
- The House never plays rounds.

## 5. Rules

### 5.1 Custody *(unchanged)*

- Deposit `x` credits `x` Principal and `x` Entries. Minimum deposit 1 USDC.
- Withdraw `x` requires Principal ≥ `x` and Entries ≥ `x`, and reduces both by `x`. Never blocked by pause, epoch state, or operator action.
- Shown before every position purchase: "After this round your withdrawable balance is min(Principal, Entries)."
- Principal never funds the jackpot, the round pot, the treasury, the reserve, or the buyback. The principal vault only ever pays withdrawals.
- Marketing consequence: the honest phrase is "withdraw any week", not "withdraw any time". A player who has spent Entries is liquid again at the next reset.

### 5.2 Entries and weight *(unchanged)*

- Entries are numbers in the Player account: not tokens, not transferable, never redeemable.
- Weight is Entries integrated over time within an epoch.
- Entries staked in a round keep earning weight for the staker. Playing never costs jackpot odds.
- At a player's first transaction in a new epoch, Entries reset to Principal and weight restarts from the epoch start. Idle depositors lose nothing.
- Total Entries always equals total Principal plus House Entries. Entries follow the owner; weight follows the delegate (4.5).

### 5.3 Epochs and the weekly draw

- Seven-day epochs. Test pools run shorter and the countdown shows real time. *(unchanged)*
- At epoch end the operator, in this order: settles the adapter and reads `G`; credits base yield; tops up reserve and treasury if enabled; splits `E` into jackpot and buyback stream; registers weight; requests randomness; pays the winner. Target: done within 15 minutes.
- Payout is pushed to the winner's USDC account. No claim, no deadline, no expiry. *(unchanged)*
- No registered weight or no randomness: jackpot rolls into the next epoch. *(unchanged)*
- Late withdrawers keep the weight and base yield earned before withdrawing. *(unchanged)*

### 5.4 Rounds

*(3.5 in the old document, with one addition)*

- 60-second rounds, positions close 5 seconds before end, continuous except the last minute of an epoch. One immutable position per round, uniform stake per tile, minimum 1 Entry per tile.
- ORAO randomness selects one tile. **Round fee:** 6% of the settled pot is credited to the House as Entries. The remaining 94% is split among positions on the winning tile pro-rata to stake on that tile. *(the old document had no fee; see 12)*
- Nobody on the winning tile: pot forfeited to the House. Randomness never arrives: round voided, pot carries forward.
- Each round also emits HEXO per section 6.

## 6. HEXO token

This section is new. It is out of scope for the devnet build (section 11) but is the agreed design.

### 6.1 Emission

- Each settled round emits **1.1 HEXO** at launch.
  - **0.1 HEXO → tile jackpot.** Accrues in a pool. Each round has a 1-in-333 chance of a hit; on a hit the accrued pool is paid to every position on the winning tile pro-rata to stake.
  - **1.0 HEXO → round winners.** A per-round coin flip (from the same VRF) decides: heads, the whole 1.0 goes to one winner on the tile chosen by weighted lot; tails, split equally among all winners on the tile.
- Voided rounds emit nothing. Rounds where nobody covers the winning tile emit only the 0.1 to the tile jackpot.
- HEXO is claimable from the Player account at any time; claiming is a user transaction.
- **Emission policy** beyond launch is an open decision (12). The design intent is that emission becomes yield-backed: the buyback stream (4.2) buys HEXO with USDC, and round rewards are drawn from what it bought, so supply tracks real yield rather than a fixed schedule.

### 6.2 Sell tax

- 10% on every HEXO sale through the in-app swap or the taxed pool: 50% burnt, 50% to the staking-yield account.
- The tax is enforced at the token level (Token-2022 transfer fee) so it applies to sales anywhere, not only in-app.

### 6.3 Staking

- Users stake HEXO in a staking account on the site. Stakers receive, pro-rata by staked amount and time:
  - The staking-yield account (37.5% of buybacks, 50% of sell tax).
  - A published share of protocol fees from the treasury. *(share is an open decision, 12)*
- Unstake has no lock at launch. A cooldown is roadmap.

### 6.4 Buying

- In-app buy routes through Jupiter with a referral fee configured on the swap; the fee lands in the pool's incentive account and becomes part of `G`.

### 6.5 Buyback execution

- The buyback stream (4.2) and House-win buybacks (4.6) are executed by the operator as a TWAP over the epoch through Jupiter, never in one transaction. Bought HEXO is split 62.5% burn / 37.5% staking yield at each fill. Every fill is an onchain event in the feed.
- Until the token launches, the buyback reserve account accumulates USDC so the launch inherits an auditable balance. *(unchanged intent)*

## 7. What the user sees

### 7.1 Arena *(unchanged, plus)*

The HEXPOT odometer under the board now shows the week's prize including the sponsor boost. The round result shows Entries won and HEXO won.

### 7.2 Vault

Deposit and withdraw. Always visible: Principal, Entries, withdrawable now, when the rest becomes withdrawable, base rate, yield earned this week and to date, and the auto-compound / pay-to-wallet toggle. Faucet on devnet. Swap-from-SOL on mainnet.

### 7.3 Weekly draw

Countdown, this week's prize with its source breakdown (depositor yield, sponsor yield, rollover), your weight and odds as a percentage, the base rate and reserve status, and recent winners. "Drawing week N" state while processing. *(APR label rule unchanged: "simulated" on devnet, "not guaranteed" on mainnet)*

### 7.4 Stake *(new)*

HEXO balance, claimable HEXO, staked amount, staking yield earned, current fee-share rate. Buy, stake, unstake, claim.

### 7.5 Delegate *(new)*

Current delegate, weight delegated to you by others, and a picker to set a new delegate. One-click "sponsor the prize" preset that delegates to the sponsorship address, with a plain warning that base yield is forfeited while delegated there.

### 7.6 Leaderboard and status *(unchanged)*

Status gains: adapter health, liquid buffer vs target, reserve balance vs target, last buyback fill.

## 8. Backend

*(section 5 of the old document, plus)*

The same NestJS process gains two modules:

- **Yield.** Talks to the adapter: deploy new Principal, unwind for withdrawals, maintain the liquid buffer, settle at epoch close, harvest incentives, report `G`. On devnet this module is the simulator.
- **Buyback.** Runs the TWAP for the buyback stream and House-win buybacks, records fills, updates burn and staking-yield accounts.

The backend still holds one keypair, still never holds user funds, still never relays user transactions.

## 9. Frontend *(unchanged, plus)*

Two new routes (Stake, Delegate), the Vault yield panel, and the prize breakdown on the weekly draw screen.

## 10. Revenue

In order of how soon each matters:

1. Protocol fee on excess yield (proposed 10% of `E`).
2. Round fee: 6% of every settled pot, taken in Entries by the House, which converts to USDC only when the House wins the draw.
3. Sell tax: half of 10% on every HEXO sale.
4. Integrator revenue: Jupiter referral fees on in-app swaps, Kamino BuildKit revenue share, KMNO season rewards on the pool position.
5. Sponsor relationships: partner brands paying for a named prize week.

Honest framing for the deck: at $100k TVL all five together are negligible; the excess-yield fee alone is ~$20k/year at $10M TVL. This is a TVL business. Round fees are the only stream that scales with play rather than deposits.

## 11. Trust and safety, honestly stated

- Principal is never at risk from the game, the draw, the operator, or the buyback. The program has no instruction that moves Principal anywhere but back to its owner or into the adapter, and the adapter can only return it to the pool.
- Base yield is a target with a reserve behind it, not a guarantee. The UI never says "guaranteed", "risk-free", or "min". On mainnet every APR carries "not guaranteed"; on devnet, "simulated".
- Randomness is ORAO VRF. Tiles, draw winners, and the HEXO coin flip come from fulfilled randomness selected by the program, not the backend.
- The operator key can open and settle rounds and epochs, run the adapter and buybacks, and fund the jackpot. It cannot change a winner, touch Principal, or block withdrawals. It can pause deposits and positions.
- Yield-source risk is real and is disclosed: Kamino smart-contract risk and USDC depeg risk are the two the user is actually exposed to. The Vault screen links to a plain-language note on both.
- Legal: prize-linked savings with consideration attached and a published base rate may be classified as gaming and/or a deposit product in Malaysia and elsewhere. No mainnet launch without a local legal read. Until then, "lottery" and "draw" stay out of Malaysia-facing marketing and the product is positioned as a game with a savings feature.

## 12. Open decisions

Everything above is agreed except these. Each has a recommendation.

1. **Base rate number.** 4% is clearable in most weeks with room left for a prize. 5–7% is not, without sponsor capital or a large reserve. Recommend 4%, one number, no range.
2. **Protocol fee on excess yield.** Recommend 10% of `E` to treasury before the 90/10 split.
3. **Reserve top-up.** Recommend 5% of `E` until two epochs of base yield are held.
4. **Round fee.** The old document had none; the flow diagram has 6%. Recommend keeping 6% — it is the only revenue that scales with play — but it must be shown on the position screen.
5. **House-win rollover.** Current split is 20/80 with no rollover. The old 30% seed made "jackpot now $X" grow week on week, which is a strong headline. Recommend reconsidering 20% treasury / 30% rollover / 50% buyback.
6. **Emission policy.** Fixed 1.1 HEXO per round is ~578k HEXO/year regardless of yield. Recommend a small fixed floor (0.2) plus a variable component drawn from what the buyback stream actually bought that epoch, smoothed so no round pays more than 3× the trailing average.
7. **Staker fee share.** Recommend 50% of treasury inflows to stakers at launch, revisited quarterly.
8. **Tile-jackpot payout.** "Pays everyone on the tile" vs "one winner on the tile". Recommend everyone, pro-rata, to match the round mechanic.

## 13. Build phases

**Phase 0 — devnet demo (this build).** Sections 3, 5, 7.1–7.3, 7.6, 8 indexer/operator/API, 9. Simulated yield through the adapter boundary. Base yield credited from the sponsor wallet at the published simulated rate; excess computed against it and funded to the jackpot the same way. Delegation built in the program (one field on the Player account, one `set_delegate` instruction, the sponsorship address initialised); the treasury delegates to it so the demo prize has a visible sponsor boost. Delegate screen ships in Phase 0 as the sponsorship preset only. No HEXO, no staking, no buyback execution, no reserve logic beyond an empty account.

**Phase 1 — mainnet, real yield.** Kamino adapter, liquid buffer, incentive harvesting, reserve, base-yield shortfall logic, full Delegate screen, Jupiter swap-from-SOL, legal review, audit, multisig, timelock.

**Phase 2 — token.** HEXO mint (Token-2022 with transfer fee), emission, tile jackpot, staking, buyback TWAP, Stake screen.

Out of scope for all phases in this document: multiple pools or assets, multiple cadences, notifications, analytics, failover beyond one VPS, KYC and geo-blocking (Phase 1 legal review decides).

## 14. Success

**Phase 0.** *(unchanged)* A judge with no Solana wallet opens the URL, gets a wallet and test USDC in under a minute, deposits, plays three rounds and sees one settle in their favour, reads their odds and their simulated base yield on the weekly draw screen, and withdraws. When the epoch ends, base yield is credited, the draw runs, and a winner's wallet receives USDC without anyone clicking anything.

**Phase 1.** A depositor who never opens the arena receives base yield every week for four consecutive weeks from real Kamino yield, and can withdraw the full deposit on any of those weeks. The prize is funded from real excess plus sponsor yield, and its breakdown on screen matches the onchain accounts to the cent.

**Phase 2.** A player who wins a round receives HEXO, stakes it, and sees staking yield arrive from a buyback fill they can find in the feed.
