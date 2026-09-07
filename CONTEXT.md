# HexVault

A no-loss lottery on Solana: users deposit USDC into a pool, the pool's yield becomes the weekly draw's prize, and each depositor's time-weighted Entries decide their odds. Entries can be risked in a MinePEA-style hex-tile game against other depositors to win more Entries, but principal is never at stake.

Player-facing words differ from mechanism names in two places, on purpose: the screen says "week" where the code says epoch, and "prize" or "hexpot" where the code says jackpot. Code, API and program identifiers keep the mechanism names.

## Language

### Custody

**Pool**:
One deployed instance of the product: one accepted asset, one principal vault, one jackpot vault, one epoch schedule. The demo runs a single hexUSDC pool.
_Avoid_: Vault (ambiguous with the token accounts), protocol

**Deposit**:
The single action that puts USDC into the pool and credits equal Principal and Entries to the depositor.
_Avoid_: Stake, mine, buy-in

**Principal**:
A depositor's 1:1 claim on the USDC they deposited, tracked as a number in their Player account. Never at risk in the game or the draw.
_Avoid_: PT, principal token, receipt, balance

**Withdraw**:
Removing principal from the pool. A withdrawal of `x` requires both Principal and Entries of at least `x`, and reduces both by `x`.
_Avoid_: Unstake, redeem, cash out

**Player**:
One wallet's account in one pool: its Principal, Entries, weight accumulator, and registration interval.
_Avoid_: User account, position (a game concept)

**House**:
The Player account owned by the pool authority. It holds no Principal, receives forfeited round pots as Entries, and competes in the draw like any player. Its Entries reset to zero each epoch.
_Avoid_: Admin wallet, protocol player, operator (a service, not an account)

**Treasury**:
The authority-owned USDC account that receives 20% of a prize the House wins.
_Avoid_: Fee account, protocol revenue

**Buyback reserve**:
The authority-owned USDC account that receives 50% of a prize the House wins, earmarked for a future token buyback.
_Avoid_: Buyback wallet, HEX fund

### Lottery

**Entries**:
A depositor's current balance of lottery weight units. Created 1:1 with Principal on deposit, moved between players by the game, and reset to equal Principal at each new epoch. Non-transferable, non-redeemable, never USDC.
_Avoid_: ET, entry token, tickets, chances, chips

**Weight**:
A player's time-weighted Entries over one epoch: the integral of Entries held over seconds elapsed. Depositing later in an epoch earns less Weight. Weight, not Entries, is what the draw selects over.
_Avoid_: TWAB, average balance, odds

**Epoch**:
One lottery cycle of fixed length. Epochs are contiguous: the next opens the moment the previous ends. The one exception is an operator that comes back a whole epoch or more late: `begin_epoch` then starts at the current time, skipping the dead gap instead of replaying it one epoch at a time. Configurable per pool; production intent is seven days, which is why the screen calls it a week.
_Avoid_: Season, draw period

**Weekly draw**:
The player-facing name for one epoch's draw and payout. The screen says "weekly draw", "week #4", "draw in 3d 4h"; code and the API say epoch.
_Avoid_: Jackpot, lottery, raffle

**Prize**:
The yield the pool earned during an epoch, paid in full to the weekly draw's single winner. The demo's yield is simulated at a published rate and labeled as such. Code and the API call this amount the jackpot (`jackpotAmount`, `fund_jackpot`).
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
One 60 second game on the 36-tile hex board. Players place Entries on tiles; VRF selects one winning tile; the round pot goes to the positions on it.
_Avoid_: Game, match, session

**Tile**:
One of the 36 indexed hex cells (0 to 35) on a round's board.
_Avoid_: Hex, cell, square

**Position**:
A Player's immutable placement in one round: a set of tiles and one uniform stake per tile, paid in Entries. A Player may hold up to eight Positions in one round; buying another is how a player adds stake or tiles.
_Avoid_: Bet, wager, deployment, mine

**Top-up**:
A second or later Position a Player buys in the same round. Nothing about earlier Positions changes.
_Avoid_: Add to bet, edit position, increase stake

**Total stake**:
The Entries a player types for one Position, split evenly across the selected tiles and floored to whole atomic Entries per tile.
_Avoid_: Bet amount, wager, stake per tile (that is the derived figure)

**Round pot**:
All Entries staked in a round plus any carry from a voided round. Distributed pro rata to the positions covering the winning tile, so the total Entries in the pool is unchanged by a round.
_Avoid_: Bonus, reward pool, prize pool

**Round reward**:
A winning position's share of the round pot, credited as Entries.
_Avoid_: Winnings, payout (a lottery concept), bonus

**Forfeit**:
A round pot whose winning tile nobody covered. It is credited to the House as Entries.
_Avoid_: Burn, rollover (a lottery concept)

**Void**:
A round whose randomness never arrived. Its pot carries into the next round's pot.
_Avoid_: Cancel, refund

### Operations

**Operator**:
The backend service that advances the protocol on a schedule: opens epochs and rounds, requests randomness, settles rounds and positions, cranks registration, funds the simulated yield, and pays the winner. Holds the authority keypair; never holds user funds.
_Avoid_: Bot, cron, CLI, admin, authority (the on-chain role name)

**Indexer**:
The backend component that mirrors program accounts and finalized events into Postgres and serves the read API the frontend uses.
_Avoid_: Cache, backend (too broad)
