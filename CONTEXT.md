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

**Withdraw**:
Removing principal from the pool. A withdrawal of `x` requires both Principal and Tickets of at least `x`, and reduces both by `x`.
_Avoid_: Unstake, redeem, cash out

**Player**:
One wallet's account in one pool: its Principal, Tickets, weight accumulator, and registration interval.
_Avoid_: User account, position (a game concept)

**House**:
The Player account owned by the pool authority. It holds no Principal, receives forfeited round pots as Tickets, and competes in the draw like any player. Its Tickets reset to zero each epoch.
_Avoid_: Admin wallet, protocol player, operator (a service, not an account)

**Treasury**:
The authority-owned USDC account that receives 20% of a prize the House wins.
_Avoid_: Fee account, protocol revenue

**Buyback reserve**:
The authority-owned USDC account that receives 50% of a prize the House wins, earmarked for a future token buyback.
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
The yield the pool earned during an epoch, paid in full to the daily draw's single winner. The demo's yield is simulated at a published rate and labeled as such. Code and the API call this amount the jackpot (`jackpotAmount`, `fund_jackpot`).
_Avoid_: Jackpot (on screen), pot, reward (a game concept)

**Hexpot**:
The jackpot vault's current balance: this epoch's prize once funded, plus anything a rollover or the House's 30% seed left behind. Shown on the odometer under the board and read straight from the token account.
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
A Prize that stays in the hexpot for the next epoch because nobody registered or the draw's randomness never arrived.
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

**Operator**:
The backend service that advances the protocol on a schedule: opens epochs and rounds, requests randomness, settles rounds and positions, cranks registration, funds the simulated yield, and pays the winner. Holds the authority keypair and the Sparring player's keypair; never holds a human depositor's funds.
_Avoid_: Bot, cron, CLI, admin, authority (the on-chain role name)

**Sparring player**:
A backend-owned Player that deposits once and buys one Position in every Round, on six to eight random Tiles at one Ticket per tile, so a lone human always has someone to play against. On screen it is indistinguishable from any other wallet, and it competes in the draw like any Player. It is not the House.
_Avoid_: Bot, house player, NPC, dummy user

**Indexer**:
The backend component that mirrors program accounts and finalized events into Postgres and serves the read API the frontend uses.
_Avoid_: Cache, backend (too broad)
