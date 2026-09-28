# HEXO

The product is HEXO (hexo.fun). `hex_vault` is the program name and HexVault the codename; neither appears on a screen.

A no-loss savings app on Solana: users deposit USDC into a pool, earn a Base yield on it, the rest of the pool's yield becomes the daily draw's prize, and each depositor's time-weighted Tickets decide their odds. Tickets can be risked in a MinePEA-style hex-tile game against other depositors to win more Tickets, but principal is never at stake.

Player-facing words differ from mechanism names in three places, on purpose: the screen says "day" where the code says epoch, "prize" or "hexpot" where the code says jackpot, and "tickets" where the code says entries. Code, API and program identifiers keep the mechanism names.

## Language

### Custody

**Pool**:
One deployed instance of the product: one accepted asset, one principal vault, one jackpot vault, one epoch schedule. The demo runs a single hexUSDC pool.
_Avoid_: Vault (ambiguous with the token accounts), protocol

**Deposit**:
The single action that puts USDC into the pool and credits equal Principal and Tickets to the depositor.
_Avoid_: Stake, mine, buy-in

**Principal**:
A depositor's 1:1 claim on the USDC they deposited, tracked as a number in their Player account. Never at risk in the game or the draw.
_Avoid_: PT, principal token, receipt, balance

**Deployed principal**:
The USDC the Admin has moved out of the principal vault to earn yield during an epoch. Readers derive it as `total_principal` minus the vault's balance; no account stores it. `admin_withdraw` refuses a pull that would leave the vault holding less than the pool's Pending withdrawals.
_Avoid_: Invested principal, float, TVL, deployed capital

**Withdraw**:
Removing principal from the pool, in two steps. A request for `x` requires Principal of at least `x`, and deducts `x` from Principal and `min(Tickets, x)` from Tickets at once. It pays out after the epoch in which it was requested ends, when anyone may push the transfer. A pause never blocks a request. Code calls the two instructions `request_withdraw` and `process_withdraw`.
_Avoid_: Unstake, redeem, cash out, instant withdrawal

**Pending withdrawal**:
A requested withdrawal whose USDC has not moved yet. It lives on the Player as `pending_withdraw` and `pending_epoch`, and is summed across the pool as `Pool.pending_withdrawals`. The Principal and Tickets behind it are already gone; the transfer happens on the first `process_withdraw` after `pending_epoch` ends, and fails with `InsufficientVaultLiquidity` while the vault is short.
_Avoid_: Queue, unbonding, escrow, claim

**Player**:
One wallet's account in one pool: its Principal, Tickets, weight accumulator, and registration interval.
_Avoid_: User account, position (a game concept)

**House**:
The Player account owned by the Operator key. It holds no Principal, receives forfeited round pots as Tickets, and competes in the draw like any player. Its Tickets reset to zero each epoch.
_Avoid_: Admin wallet, protocol player, operator (a service, not an account)

**Treasury**:
The USDC account that receives 20% of a prize the House wins. `create_pool` is given its address, and on mainnet that address is the Admin multisig's associated token account.
_Avoid_: Fee account, protocol revenue

**Buyback reserve**:
The USDC account that receives 50% of a prize the House wins, earmarked for a future token buyback. Its address is set at `create_pool` like the Treasury's.
_Avoid_: Buyback wallet, HEX fund

**Base yield**:
The fixed rate every depositor earns on their time-weighted Principal, credited into Principal once per ended epoch. Paid only out of the Yield budget, so it stops rather than runs a debt when the budget is empty.
_Avoid_: Interest, APY (as the mechanism name), staking reward

**Yield budget**:
USDC already sitting in the principal vault that is earmarked for Base yield and not yet credited to anyone. Anyone can top it up; each credit draws it down.
_Avoid_: Reserve, yield pool

### Lottery

**Bought tickets**:
Tickets a depositor pays USDC for, at a pool-set number of Tickets per USDC, up to their Principal in USDC per epoch. The USDC goes to the jackpot vault and is never returned. Bought tickets are ordinary Tickets from the moment they land.
_Avoid_: Purchased entries, deposit (a bought ticket is not Principal)

**Granted tickets**:
Tickets credited to a Player by the Operator key or the Admin rather than earned by depositing, buying or playing. Operator grants are capped per Player and per pool per epoch; Admin grants are not. Ordinary Tickets once credited.
_Avoid_: Minted tickets, airdrop, free tickets (those are the daily reset)

**Referral bonus**:
The Granted tickets a Referrer receives at the start of each epoch: a rate set by their count of Qualified referrals, applied to those referrals' Principal.
_Avoid_: Commission, referral reward pool


**Tickets**:
A depositor's current balance of lottery weight units. Created 1:1 with Principal on deposit, added by Bought tickets and Granted tickets, moved between players by the game, and reset to equal Principal at each new epoch. Non-transferable, non-redeemable, never USDC. Code, the API and the program call them entries (`Player.entries`); the screen and this glossary say Tickets.
_Avoid_: Entries (on screen), ET, entry token, chances, chips

**Weight**:
A player's time-weighted Tickets over one epoch: the integral of Tickets held over seconds elapsed. Depositing later in an epoch earns less Weight. Weight, not Tickets, is what the draw selects over.
_Avoid_: TWAB, average balance, odds

**Epoch**:
One lottery cycle. Its boundaries are points on a fixed grid: the pool's Anchor sets where the grid sits, and the cycle length, a pool parameter, sets the spacing. Epochs are contiguous, and a late crank lands on the same grid a punctual one would, so an operator outage skips whole epochs instead of moving the boundary. A pool's first epoch is the short stub from launch to the next grid point.
_Avoid_: Season, draw period

**Anchor**:
The timestamp that fixes the phase of a pool's epoch grid, so the draw ends at the same clock time every cycle instead of at whatever second the pool launched. The pool's anchor is a Sunday 16:00 UTC, one instant that sits on the hourly, daily and weekly grids at once, so changing the cycle length never moves the draw off midnight Malaysian time.
_Avoid_: Epoch start, genesis, offset

**Daily draw**:
The player-facing name for one epoch's draw and payout. The screen says "daily draw", "day #4", "draw in 3h 20m"; code and the API say epoch. The cycle length is a pool parameter, so the name follows the pool's cadence rather than fixing it.
_Avoid_: Jackpot, lottery, raffle

**Prize**:
What the jackpot vault holds for an epoch at close, paid in full to the daily draw's single winner: yield the pool earned above Base yield, sponsor money, and Bought tickets' USDC. The Admin harvests the yield and funds the jackpot vault by hand before the draw, through the permissionless `fund_jackpot`. Code and the API call this amount the jackpot (`jackpotAmount`, `fund_jackpot`).
_Avoid_: Jackpot (on screen), pot, reward (a game concept)

**Hexpot**:
The jackpot vault's current balance: this epoch's prize once funded, plus anything a rollover or the House's 30% seed left behind. Shown on the odometer under the board, served by the Read model, which reads the vault balance on the browser's behalf.
_Avoid_: Jackpot (on screen), honeypot, prize pool

**Registration**:
Recording one Player's final Weight for an ended epoch as a contiguous interval in that epoch's total. Permissionless; the operator cranks it for every player right after the epoch ends.
_Avoid_: Snapshot, Merkle commit, freeze

**Draw**:
The verifiable random selection of one point in an epoch's total registered Weight via ORAO VRF. The Player whose interval contains the point wins the Prize.
_Avoid_: Snapshot, lottery, raffle

**Payout**:
Moving the Prize from the jackpot vault into the principal vault and adding it to the winner's Principal, so it compounds and is withdrawn like any other Principal. No claim step, and no signer: the operator cranks it, but anyone can, because the winner is fixed on chain. If the House wins, the Prize splits 50% buyback reserve, 30% stays for the next epoch, 20% treasury.
_Avoid_: Claim, redeem

**Rollover**:
A Prize that stays in the hexpot for the next epoch because nobody registered, the draw's randomness never arrived, or the jackpot vault held less than the pool's `min_jackpot` when registration closed.
_Avoid_: Expiry, unclaimed prize

### Game

**Round**:
One 60 second game on the 36-tile hex board. Players place Tickets on tiles; VRF selects one winning tile; the round pot goes to the positions on it.
_Avoid_: Game, match, session

**Tile**:
One of the 36 indexed hex cells (0 to 35) on a round's board.
_Avoid_: Hex, cell, square

**Position**:
A Player's immutable placement in one round: a set of tiles and one uniform stake per tile, paid in Tickets. A Player may hold up to eight Positions in one round; buying another is how a player adds stake or tiles.
_Avoid_: Bet, wager, deployment, mine

**Top-up**:
A second or later Position a Player buys in the same round. Nothing about earlier Positions changes.
_Avoid_: Add to bet, edit position, increase stake

**Total stake**:
The Tickets a player types for one Position, split evenly across the selected tiles and floored to whole atomic Tickets per tile.
_Avoid_: Bet amount, wager, stake per tile (that is the derived figure)

**Round pot**:
All Tickets staked in a round plus any carry from a voided round. After the House cut, the rest is distributed pro rata to the positions covering the winning tile, so the total Tickets in the pool is unchanged by a round.
_Avoid_: Bonus, reward pool, prize pool

**House cut**:
A pool-configurable percentage of a settled round's pot, credited to the House as Tickets before the winners split the remainder. It is taken from the pot as a whole, so every winner pays it on their gross round reward, own stake included. Forfeited and voided rounds have no House cut. PRD-V2 calls this the round fee.
_Avoid_: Round fee, tax, rake, commission

**Round reward**:
A winning position's share of the round pot after the House cut, credited as Tickets.
_Avoid_: Winnings, payout (a lottery concept), bonus

**Forfeit**:
A round pot whose winning tile nobody covered. It is credited to the House as Tickets.
_Avoid_: Burn, rollover (a lottery concept)

**Void**:
A round whose randomness never arrived. Its pot carries into the next round's pot.
_Avoid_: Cancel, refund

### Growth

**Invite code**:
A single-use code that lets a wallet past the beta gate. It may have an owner. Goes away with the beta. The gate is in the app, not the program.
_Avoid_: Access token, whitelist, referral code (a different thing)

**Referral code**:
A depositor's own code, one per wallet, unlimited uses, shared as a link. Applying it before a wallet's first deposit makes its owner that wallet's Referrer. Outlives the beta; does not pass the beta gate.
_Avoid_: Invite code (a different thing), promo code

**Referrer**:
The owner of the Referral code a wallet applied before its first deposit, or failing that, the owner of the Invite code it redeemed. Fixed for good once written.
_Avoid_: Sponsor, upline, inviter

**Qualified referral**:
A wallet whose Referrer is set and whose Principal has stayed at or above 50 USDC for the last 7 days without a break. Dropping below ends it at once; it restarts the 7 days from zero. The screen labels it "Active".
_Avoid_: Active referral (outside screen copy), crew member

### Operations

**Admin**:
The multisig or wallet that changes pool parameters, unpauses (including starting the game and the jackpot on a new pool), rotates the Operator key, and moves principal out of the vault to a yield venue and back. It is `Pool.admin` in the program, a Squads multisig on mainnet, and it never signs a round. The role moves in two steps, `propose_admin` then `accept_admin`, so a typo cannot hand the pool to an address nobody holds.
_Avoid_: Authority (the removed program role), owner, admin wallet, Operator

**Operator key**:
The hot keypair on the VPS that the Operator service signs with, and `Pool.operator` in the program. It exclusively opens epochs and rounds and crank registration closed; settling, voiding, drawing and rolling over an epoch are permissionless (production-hardening ticket 01), so the Operator key still cranks them but a stalled or stolen one cannot withhold a fulfilled result or leave a timed-out request stuck. It owns the House Player. Paying the winner needs no signer, so it only pays that transaction's fee. It cannot change parameters, unpause, or move principal. The Admin rotates it in one transaction.
_Avoid_: Authority keypair, pool authority, admin key, hot wallet

**Operator**:
The backend service that advances the protocol: opens epochs and rounds, requests randomness, settles rounds and positions, cranks registration, pays the winner, and pushes each Pending withdrawal once its epoch has ended. Deadline-driven: it sleeps until the next moment a decision could change rather than running on a fixed schedule, with a slow safety tick as its backstop. Signs with the Operator key and the Sparring player's keypair; never holds a human depositor's funds.
_Avoid_: Bot, cron, CLI, admin (a separate role), authority (the removed program role)

**Sparring player**:
A backend-owned Player that deposits once and buys one Position in every Round, on all 36 Tiles at one Ticket per tile, so a lone human always has someone to play against on whichever tile wins. On screen it is indistinguishable from any other wallet, and it competes in the draw like any Player. It is not the House.
_Avoid_: Bot, house player, NPC, dummy user

**Read model**:
The Indexer's Postgres mirror of program accounts and finalized events, and the only path by which the browser learns anything about the protocol. A cache may be bypassed for a fresher read; the Read model may not, since the browser keeps no chain read of its own to fall back to.
_Avoid_: Cache, backend

**Indexer**:
The backend component that mirrors program accounts and finalized events into Postgres. It is the Read model: the browser's only path to learning anything about the protocol.
_Avoid_: Cache, backend (too broad)

**Pause**:
A reversible pool state (`Pool.paused`) that stops all Ticket movement, `buy_position` and both `grant_tickets` paths, while leaving an open Round free to finish: `request_withdraw`, `process_withdraw`, `settle_round`, `void_round`, `settle_position`, `close_round`, the epoch cranks and `fund_*` all stay open. Either the Admin or the Operator key can set it; only the Admin can unset it, so a stolen hot key can cost a day of rounds but cannot reopen a pool the team has halted.
_Avoid_: Shutdown (a separate, irreversible state), freeze, halt

**Shutdown**:
An admin-only, irreversible pool state (`Pool.shutdown`) that stops every inflow, the game and the draw, and lets withdrawals skip the epoch lock. Set once, by `shutdown`. Modelled on Marginfi/Kamino's ReduceOnly.
_Avoid_: Pause (a separate, reversible state), wind-down, freeze

**Game pause**:
A reversible pool switch (`Pool.game_paused`) that stops new Rounds opening and new Positions being bought. A Round already open still settles or voids, so no stake is stuck. Either key can turn it on; only the Admin can turn it off, and never after Shutdown. A new pool starts with it on, so turning it off is how the game starts. Set by `set_feature_pause`.
_Avoid_: Freeze, stop the board

**Jackpot pause**:
A reversible pool switch (`Pool.jackpot_paused`) that stops the epoch cycle at its next step: no new Epoch begins, no Tickets are bought or granted, and a Registering Epoch does not close for the draw. Registration stays open, and an Epoch already Drawing or Drawn still draws and pays. Rounds live inside an Epoch, so once the current one ends the game stops too. Same key rules and starting state as the Game pause.
_Avoid_: Draw freeze, skip the draw

**Emergency withdraw**:
A permissionless crank, valid only once a pool is shut down, that pays one Player's whole Principal and pending withdrawal to their own wallet in one instruction (`emergency_withdraw`). Anyone may run it for any Player; the House is excluded, since its principal is protocol money and leaves through a Sweep instead.
_Avoid_: Force withdraw, bailout, rescue

**Sweep**:
The admin-only `sweep_house`, valid only once a pool is shut down, that moves the jackpot vault's surplus over `jackpot_reserved` and whatever of the Yield budget the principal vault still holds unspent to the Treasury. Never touches Principal; callable more than once.
_Avoid_: Drain, liquidate, close out

**Principal out**:
`total_principal` plus Pending withdrawals plus the Yield budget, minus the principal vault's live balance, floored at zero: how much the Admin has moved out via `admin_withdraw` and not yet returned. Wider than Deployed principal above, which ignores Pending withdrawals and the Yield budget. Read with `admin principal-out` or `GET /status`'s `principalOut`.
_Avoid_: Deployed principal (the narrower figure), TVL gap

**Environment**:
One deployment of the whole stack: its own program keypair, its own pools, its own Postgres database and its own env file. Dev, staging and mainnet share nothing but the box and Traefik. See `docs/ops/environments.md`.
_Avoid_: Env (fine in code and flags), cluster (a Solana term, narrower than this)
