# HexVault

A no-loss lottery on Solana: users deposit USDC into a pool, the pool's yield becomes the daily draw's prize, and each depositor's time-weighted Tickets decide their odds. Tickets can be risked in a MinePEA-style hex-tile game against other depositors to win more Tickets, but principal is never at stake.

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

### Lottery

**Tickets**:
A depositor's current balance of lottery weight units. Created 1:1 with Principal on deposit, moved between players by the game, and reset to equal Principal at each new epoch. Non-transferable, non-redeemable, never USDC. Code, the API and the program call them entries (`Player.entries`); the screen and this glossary say Tickets.
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
The yield the pool earned during an epoch, paid in full to the daily draw's single winner. The Admin harvests the yield and funds the jackpot vault by hand before the draw, through the permissionless `fund_jackpot`. Code and the API call this amount the jackpot (`jackpotAmount`, `fund_jackpot`).
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
The operator-cranked transfer of the Prize to the winner's USDC account. No claim step. If the House wins, the Prize splits 50% buyback reserve, 30% stays for the next epoch, 20% treasury.
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

### Operations

**Admin**:
The multisig or wallet that changes pool parameters, unpauses, rotates the Operator key, and moves principal out of the vault to a yield venue and back. It is `Pool.admin` in the program, a Squads multisig on mainnet, and it never signs a round. The role moves in two steps, `propose_admin` then `accept_admin`, so a typo cannot hand the pool to an address nobody holds.
_Avoid_: Authority (the removed program role), owner, admin wallet, Operator

**Operator key**:
The hot keypair on the VPS that the Operator service signs with, and `Pool.operator` in the program. It opens epochs and rounds, requests randomness, settles, registers, draws and pays out, and it owns the House Player. It cannot change parameters, unpause, or move principal. The Admin rotates it in one transaction.
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
