# HexVault product requirements

Status: agreed product definition, September 2026. Supersedes every earlier product, tokenomics, and launch document, which have been deleted. Vocabulary is defined in [`CONTEXT.md`](../CONTEXT.md); this document uses those words and no others.

## 1. What it is

HexVault is a no-loss lottery on Solana with a game bolted on.

You deposit USDC. Your principal is never at risk and you can withdraw it whenever you want. The yield the pool earns during an epoch becomes that week's prize, and the weekly draw pays the whole thing to one depositor. Your odds are your time-weighted Entries: deposit one USDC for a full day and you hold one day of weight. That is PoolTogether.

The twist is the game. Your Entries are also chips on a 36-tile hex board. Every 60 seconds a round runs: players put Entries on tiles, a verifiable random draw picks one tile, and everyone who covered it splits the whole round pot. Losers' Entries go to winners, not to the house. Win rounds and you carry more weight into the weekly draw. Lose and you can still withdraw every cent you deposited, once your Entries reset at the next epoch. That is MinePEA, played with lottery odds instead of money.

On screen the epoch is a week, the amount is the prize, and the jackpot vault's balance under the board is the hexpot. Code, API and program keep `epoch` and `jackpot` as identifiers; see `CONTEXT.md`.

The demo runs on Solana devnet with a test USDC mint we control. Yield is simulated at a published rate and labeled as simulated everywhere it appears.

## 2. The loop

1. Connect a wallet. Privy embedded wallet by default so anyone can play in under a minute; Phantom and friends via the standard adapter.
2. Get test USDC from the in-app faucet.
3. Deposit. You receive equal Principal and Entries.
4. Play rounds. Stake Entries on tiles, watch the draw, collect round rewards as Entries.
5. Wait for the epoch to end. The operator registers every player's weight, draws a winner with ORAO VRF, and pushes the prize to the winner's wallet.
6. New epoch. Entries reset to Principal. Play again, or withdraw.

## 3. Rules

### 3.1 Custody

- Deposit `x` credits `x` Principal and `x` Entries. Minimum deposit 1 hexUSDC.
- Withdraw `x` requires Principal of at least `x` and Entries of at least `x`, and reduces both by `x`. This is the only withdrawal rule. It is never blocked by pause, epoch state, or operator action.
- Consequence shown before every position purchase: "After this round your withdrawable balance is min(Principal, Entries)". If you stake 40 of 100 Entries and lose, you can withdraw 60 now and the other 40 after the epoch resets your Entries.
- Principal never funds the jackpot, the round pot, the treasury, or anything else. The principal vault only ever pays withdrawals.

### 3.2 Entries and weight

- Entries are numbers in your Player account. They are not tokens, cannot be transferred, and are never redeemable for anything.
- Weight is Entries integrated over time within an epoch. Holding 100 Entries for 12 hours of a 24 hour epoch gives the same weight as holding 50 for the full day.
- Entries staked in a round keep earning weight for the staker for the duration of that round. Playing a lot never costs you jackpot odds.
- At the first transaction a player makes in a new epoch, the program resets their Entries to their Principal and restarts weight accrual from the epoch's start time. Idle depositors lose nothing by being idle.
- Total Entries in the pool always equals total Principal plus the House's Entries. The game only moves Entries between players.

### 3.3 Epochs and the weekly draw

- Epochs are contiguous and of fixed length, set on the pool by the authority. Seven days, so the screen can call it a week without lying. Test pools run shorter epochs and the countdown shows the real time.
- When an epoch ends, the operator registers each player's final weight as an interval in the epoch's total, funds the jackpot with the epoch's yield, requests randomness, and pays the winner. Target: done within 15 minutes of epoch end. No player action needed, though any player can register themselves from the UI.
- A player who withdraws late in an epoch keeps the weight they earned before withdrawing. Their principal earned yield for that time.
- A deposit made while the previous epoch's draw is still processing counts toward the new epoch.
- Payout is pushed to the winner's USDC account. There is no claim, no claim deadline, and no expiry.
- If nobody registered any weight, or the randomness never arrives, the jackpot rolls over into the next epoch.

### 3.4 Simulated yield

- At registration close the operator computes `jackpot = total_principal × 5% × epoch_seconds / 365 days`, with a floor of 10 hexUSDC so an empty demo pool still shows a prize, and transfers it from the sponsor wallet into the jackpot vault.
- Every place the UI shows a jackpot, APR, or yield it says "simulated". The pool does not lend, stake, or otherwise deploy principal anywhere.
- The program exposes a single funding instruction for the jackpot vault. A real yield adapter later would call the same instruction with real surplus and nothing else changes.

### 3.5 Rounds

- A round lasts 60 seconds. Positions close 5 seconds before the end. The operator opens the next round as soon as the previous one settles. Rounds run continuously except for the last minute of an epoch, where a round would cross the boundary.
- A player buys at most one position per round: any non-empty set of tiles at one uniform stake per tile, paid in Entries. Minimum 1 Entry per tile, no maximum.
- Positions are immutable. No cancel, no top-up.
- At close the operator requests ORAO randomness. On fulfillment the program selects one tile and the round is settled. Every position covering that tile receives `pot × its stake on the tile / total stake on the tile`, credited as Entries. Positions on other tiles receive nothing.
- Nobody on the winning tile: the pot is forfeited to the House.
- Randomness never arrives: the round is voided and its pot carries into the next round's pot.
- The operator cranks settlement of every position after each round and closes the position account, returning its rent to the player. A player can also settle their own position from the UI.

### 3.6 The House

- The House is a Player account owned by the pool authority. It has no Principal.
- It receives forfeited round pots as Entries and competes in the jackpot draw with the weight those Entries earn. Its Entries reset to zero each epoch like everyone else's reset to Principal.
- If the House wins the jackpot: 50% goes to the buyback reserve account, 30% stays in the jackpot vault as the seed for the next epoch, 20% goes to the treasury account. All three are on-chain accounts anyone can inspect.
- The House never plays rounds.

## 4. What the user sees

### 4.1 Arena

The existing HEXO arena design stays. The board shows the live round: tiles, your selection, stake per tile, total Entries in, Entries after, withdrawable after, round pot, countdown, then the draw animation and the result. Under the board, the HEXPOT odometer shows the jackpot vault's balance. A feed shows recent deposits, positions, round results, and prize payouts. Animations are cosmetic; the settled on-chain result is what the UI reports.

### 4.2 Vault

Deposit and withdraw. Always visible: Principal, Entries, withdrawable now, and when the rest becomes withdrawable. Faucet button on devnet.

### 4.3 Weekly draw

Countdown to the draw, this week's prize with the "simulated 5% APR" label, your weight and your odds as a percentage of total weight so far, and the last few winners with amounts. During the minutes after an epoch ends, a "drawing week N" state with registration progress.

### 4.4 Leaderboard

Top players by weight this week.

### 4.5 Status

A small indicator sourced from the backend: operator alive, last tick, last error, current round id. If the operator is stalled the arena says so instead of spinning.

## 5. Backend

One NestJS service with Prisma on Postgres, deployed on the Contabo VPS behind the existing Traefik. It has three modules in one process:

- **Indexer.** Mirrors program accounts into Postgres every two seconds and ingests finalized program events for the feed and history.
- **Operator.** A two-second tick that reads on-chain state and does whatever the protocol needs next: open epoch, open round, request randomness, settle round, settle positions, register players, fund jackpot, close registration, draw, pay out, void, roll over. Idempotent: every action is gated by the program, so a repeated call fails harmlessly.
- **API.** Read endpoints for the frontend, a status endpoint, and the faucet.

The backend holds one keypair, the pool authority. It never holds user funds and never relays user transactions. Users sign everything in their own wallet.

## 6. Frontend

The existing Vite React app in `apps/web`, rewired. Reads its own Player account and the current round directly from the RPC so balances and the board are exact and instant; reads everything aggregate from the API. Polls the API every two seconds and subscribes to the round-settled event over the RPC websocket for the animation. Deployed on Vercel.

## 7. Trust and safety, honestly stated

- Principal is never at risk from the game, the draw, or the operator. The program has no instruction that moves principal anywhere but back to its owner.
- Randomness is ORAO VRF on devnet. Round tiles and jackpot winners are selected from the fulfilled randomness by the program, not by the backend.
- The operator key can open and settle rounds and epochs, and fund the jackpot. It cannot change the winner, touch principal, or block withdrawals. It can pause deposits and new positions.
- This is a devnet prototype. One key, one server, simulated yield, no audit, no legal review. Nothing in the UI may say "risk-free", "guaranteed", or quote an APR without the word "simulated".

## 8. Out of scope for this build

- The HEX token, buyback execution, and game rewards paid in a token. The buyback reserve account exists so the future token launch inherits an auditable balance; nothing else is built.
- A real yield source. The funding instruction is the boundary; the adapter is future work.
- Multiple pools, multiple assets, multiple cadences running at once. One pool, one mint, one epoch length at a time.
- Mainnet, multisig, timelock, independent audit, legal classification, KYC, geo-blocking.
- Email or push notifications, WCAG audit, analytics.
- Failover, multi-region, or anything beyond one VPS and `docker compose up`.

## 9. Success for the demo

A judge with no Solana wallet can open the Vercel URL, get a wallet and test USDC in under a minute, deposit, play three rounds and see one settle in their favor, read their odds on the weekly draw screen, and withdraw. When the epoch ends, the draw runs and a winner's wallet receives USDC without anyone clicking anything.
