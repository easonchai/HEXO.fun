# PRD v1 vs v2, and where the code stands against v2

Date: 2026-09-07. Scope: `docs/product-requirements.md` (v1) against `docs/PRD-V2.md` (v2), then the program, backend and web app against v2 Phase 0. Token features (v2 section 6, Phase 2) are skipped on request. Every code claim below was checked against the file named.

## 1. What changed from v1 to v2

| Area | v1 | v2 |
|---|---|---|
| Name | HexVault, HEX token | HEXO.fun, HEXO token. `CONTEXT.md` still says HexVault/HEX. |
| Positioning | No-loss lottery with a game bolted on | Prize-linked savings with four optional layers: Save, Draw, Play, Token. New section 2 defines the target user. |
| Yield | Simulated only. `jackpot = principal × 5% × epoch/365d`, floor 10 hexUSDC, all of it is the prize. | Yield adapter boundary (Kamino on mainnet, simulator on devnet). Gross yield `G` runs a waterfall: base yield `B` to every depositor first, excess `E = G − B` split 90% jackpot / 10% buyback stream. Proposed 5% reserve top-up and 10% protocol fee off `E`. |
| Base yield | None. Depositors earn nothing directly; the prize is the only upside. | `base_rate` pool parameter, launch target 4%. Paid at epoch close, auto-compounded into Principal by default (mints matching Entries) or pushed to wallet. Shortfalls covered by a reserve. |
| Reserve | Does not exist | New onchain USDC account. Phase 0 ships it empty. |
| Delegation / sponsorship | Does not exist | `delegate` field on Player, `set_delegate` instruction, a sponsorship address. Entries stay with the owner, weight and prize go to the delegate. Delegating to the sponsorship address forfeits base yield and draw odds and feeds `E`. Phase 0: program support plus a one-click sponsor preset, and the treasury delegates to it. |
| House win split | 50% buyback reserve / 30% stays in jackpot / 20% treasury | 20% treasury / 80% buyback, no rollover. Open decision 5 recommends going back to 20/30/50. |
| Round fee | None. Winners on the tile split 100% of the pot. | 6% of every settled pot to the House as Entries; winners split 94%. Must be shown on the position screen. Open decision 4. |
| Epoch close order | Register, fund jackpot, close, draw, pay | Settle adapter, credit base yield, reserve and treasury top-ups, split `E`, register, request randomness, pay |
| Funding | Devnet faucet | Faucet on devnet; USDC or Jupiter swap-from-SOL on mainnet |
| Screens | Arena, Vault, Weekly draw, Leaderboard, Status | Same plus Stake (Phase 2) and Delegate (sponsor preset only in Phase 0). Vault gains base rate, yield this week and to date, compound toggle. Weekly draw gains a prize source breakdown (depositor yield, sponsor yield, rollover), base rate and reserve status. Status gains adapter health, liquid buffer, reserve, last buyback fill. |
| Backend | Indexer, Operator, API | Plus Yield module (the simulator on devnet) and Buyback module (Phase 2) |
| Copy rules | Never "risk-free", "guaranteed", or an APR without "simulated" | Same, plus never "min". Mainnet APRs say "not guaranteed". Marketing says "withdraw any week", not "any time". "Lottery" and "draw" stay out of Malaysia-facing copy. |
| Revenue | Not discussed | Section 10 ranks five streams and states it is a TVL business |
| Legal | "No legal review" | Explicit note that the product may be classed as gaming or a deposit product; no mainnet without a local legal read |
| Phases | One devnet build | Phase 0 devnet, Phase 1 mainnet with real yield, Phase 2 token |
| Open decisions | None | Section 12 lists eight |

Unchanged in substance: custody rule (withdraw needs Principal and Entries ≥ x, never blocked), Entries and weight mechanics, seven-day contiguous epochs, push payout with no claim, rollover on no weight or no randomness, 60 s rounds with a 5 s close buffer, one immutable position per round, forfeit to the House, void carries the pot, ORAO VRF, one operator key, out-of-scope list.

## 2. Code against v2 Phase 0

Phase 0 per v2 section 13 is: sections 3, 5, 7.1 to 7.3, 7.6, backend indexer/operator/API, section 9, simulated yield through the adapter boundary, base yield credited from the sponsor wallet, excess funded to the jackpot, delegation in the program, sponsorship address initialised, treasury delegated to it, Delegate screen with the sponsor preset, an empty reserve account. No HEXO, no staking, no buyback execution.

### 2.1 Not built (required by Phase 0)

1. **Base yield to depositors.** The operator computes one amount and sends all of it to the jackpot vault. `apps/backend/src/operator/tick.ts:34` (`yieldAmount`) is still the v1 formula: `principal × APR_BPS × epoch / year`, floored at `JACKPOT_FLOOR`, default 500 bps and 10 hexUSDC (`apps/backend/src/config/env.ts:45`). Nothing credits Principal or pushes USDC to depositors. There is no `base_rate` on `Pool` (`programs/hex_vault/src/state.rs`), no waterfall, no `E`.
2. **Delegation.** `Player` has no `delegate` field (`state.rs:104`). There is no `set_delegate` instruction (`lib.rs` lists 18 instructions; none touch delegation). `register` writes weight under the player's own account (`epochs.rs`). No sponsorship address exists, so the treasury cannot delegate to it.
3. **Reserve account.** `Pool` holds `treasury` and `buyback_reserve` only. No reserve pubkey, no empty account created in `create_pool` (`custody.rs`).
4. **Delegate screen.** The web app has five tabs: MINE, VAULT, WEEKLY DRAW, LEADERBOARD, ABOUT (`apps/web/src/App.tsx:472-547`). No Delegate route, no sponsor preset.
5. **Vault yield panel.** `apps/web/src/screens/Vault.tsx` shows Principal, Entries, withdrawable now and a faucet. No base rate, no yield this week or to date, no compound / pay-to-wallet toggle.
6. **Prize source breakdown.** `WeeklyDraw.tsx:123` shows one figure labelled "Prize (simulated 5% APR)". No depositor / sponsor / rollover split, no base rate, no reserve status, no "boosted by sponsors".
7. **Yield module.** The backend has admin, api, bootstrap, chain, config, health, idl, indexer, operator, prisma. No yield module; the simulator is two env vars and one function inside the operator.
8. **Status additions.** `GET /status` (`apps/backend/src/api/api.controller.ts:78`) has no adapter health, liquid buffer, or reserve fields.

### 2.2 Built to v1, contradicts v2

1. **House win split is 50/20/30.** `epochs.rs:287-320`: `buyback_amount = amount / 2`, `treasury_amount = amount / 5`, the rest stays in the vault. v2 says 20% treasury / 80% buyback. Open decision 5 recommends 20/30/50, which is a third split, so hold until decided.
2. **No round fee.** `settle_position` (`rounds.rs:243`) pays `pot × stake / tile_total` with no deduction. The House gets Entries only on forfeit (`rounds.rs:216-225`). v2 5.4 says 6% to the House on every settled round. Open decision 4, but v2 marks it as recommended to keep.
3. **Naming.** Program crate, IDL and types are `hex_vault` / `HexVaultProgram`. The About screen opens with "HexVault is a no-loss lottery prototype" (`About.tsx:12`). The nav logo already says HEXO (`App.tsx:347`). `CONTEXT.md` still says HexVault, HEX, and the 50/30/20 split.

### 2.3 Matches v2 (unchanged sections, verified)

- Custody: deposit requires `amount >= min_deposit` and `!paused`; withdraw checks Principal and Entries and ignores pause (`custody.rs:160-208`).
- Entries reset and weight: `touch.rs` resets Entries to Principal on the first action in a new epoch, House resets to zero (test at `touch.rs:304`).
- Epoch flow: register (batched by 8), fund + close in one tx, draw on fulfilment, rollover after `vrf_timeout` (`tick.ts:157-215`). Funding source is the authority's hexUSDC account, minting the shortfall on devnet (`instructions.ts:127-173`). That is the "sponsor wallet".
- Rounds: one position per owner per round, enforced by the PDA seed `[position, round, owner]` with `init` (`rounds.rs:380-388`). Positions close at `ends_at − close_buffer` (`rounds.rs:93-97`). Rounds cannot cross the epoch end (`rounds.rs:48`). Forfeit credits the House; void carries the pot.
- Payout is pushed to the winner's token account, no claim (`epochs.rs:322-335`).
- Copy: "simulated" appears on the hexpot tooltip, About, and the weekly draw label. No "guaranteed", "risk-free", or "min" in `apps/web/src`.
- Position consequence: the control panel shows Entries after and withdrawable after before deploy (`ControlPanel.tsx:314-317`).
- Status indicator, leaderboard, feed, faucet: present.

### 2.4 Drift worth noting (not v2 items)

- `CONTEXT.md` says a Player may hold up to eight Positions per round with top-ups. The program still allows exactly one (the `docs/plan/additive-positions` spec is `ready-for-agent`, not landed). Both PRDs say one. Either land the spec or revert the glossary.
- The weekly draw label hardcodes "5% APR" while the rate is `APR_BPS` from env. If the rate changes to v2's 4% target, the copy lies.
- `set_pause` gates deposits and `create_round` (`rounds.rs:20`) but not `buy_position`. Positions stop only because no new round opens. v2 11 says the operator "can pause deposits and positions"; behaviour is equivalent in practice, one open round of lag.

## 3. Suggested order

1. Decide open decisions 4 and 5 before touching `payout` or `settle_position`, so the split is changed once.
2. Program: add `delegate` to `Player` and `set_delegate`, a `base_rate_bps` and `reserve` on `Pool`, a `credit_base_yield` path (auto-compound is the smaller change: bump Principal and Entries, transfer from the sponsor wallet to the principal vault). These are IDL changes, so batch them into one deploy.
3. Operator: split `yieldAmount` into `B` and `E`; credit `B` per player during the registration crank, fund the jackpot with 90% of `E`, park 10% in the buyback reserve.
4. Web: Vault yield panel, prize breakdown, Delegate tab with the sponsor preset.
5. Rename: About copy and `CONTEXT.md` first, the crate and IDL identifiers when the program redeploys anyway.
