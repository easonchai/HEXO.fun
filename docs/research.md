# Product and integration research

Research performed before implementation.

## Reference mechanics

MinePEA provides a 60-second, fixed-grid mining game: users choose tiles and stake ETH per tile; Pyth VRF selects a tile; miners on it share the remaining round value pro rata after a 10% fee. Its grid is a useful interaction reference, but staking ETH that can be lost is incompatible with HexVault’s no-loss-principal goal.

The supplied mock UI changes the board to 36 hex tiles and shows one immutable deployment per round, amount per tile, multiple rounds, an animated central orb, a HexPot, and winner feedback. Those presentation assets are treated as a design reference only; no mock pseudo-randomness or JavaScript game state becomes protocol truth.

PoolTogether validates the prize-linked-savings concept: user deposits retain withdrawal value while yield/prize liquidity funds drawings. HexVault adds an active, entry-only game layer; it must retain principal/prize separation.

## Adopted model

- Deposit `$1.00` devnet USDC → 1.00 PT + 1.00 ET.
- PT and ET are non-transferable and use the same six-decimal unit scale as USDC.
- Each weekly epoch is an entry season. ET can be spent in game rounds; lower ET limits matched PT withdrawal.
- After that week’s prize snapshot/finalization, an owner may refresh ET to exactly their remaining PT. Game-earned ET therefore matters before the weekly draw but does not create perpetual/redeemable value.
- A winning game position can earn ET, not USDC. The weekly lottery prize is separate USDC from `PrizeVault`.

## Randomness finding

Pyth’s current Entropy documentation calls it a random-number generator “for Ethereum smart contracts,” and its public chain list does not contain Solana. Therefore this repository cannot truthfully claim a Pyth VRF Solana integration today. The program exposes an asynchronous callback interface and a test provider; a production SVM provider must be explicitly configured and audited. ORAO and Switchboard should be evaluated with their current Solana support, availability, callback verification, cost, and incident history before selecting one.

Sources:

- MinePEA: <https://www.minepea.com/docs/intro>, <https://www.minepea.com/docs/mining>, <https://www.minepea.com/docs/staking>, <https://www.minepea.com/docs/tokenomics>
- PoolTogether: <https://docs.pooltogether.com/>
- Pyth Entropy: <https://docs.pyth.network/entropy>, <https://docs.pyth.network/entropy/chainlist>
- Kamino developer documentation: <https://docs.kamino.finance>
- Anchor documentation: <https://www.anchor-lang.com/docs>

## Yield analysis

There is no safe universal “expected yield” for Solana USDC. Lending rates vary with borrower demand, reserve configuration, rewards, stablecoin depeg risk, smart-contract risk, liquidity, and operation of the strategy. Kamino documents a lending-vault SDK/API and separate risk material, making it a candidate integration rather than a guaranteed source of 4–6%.

The early build keeps devnet principal in `PrincipalVault` and uses sponsor-funded `PrizeVault` deposits. A later adapter must be separately audited and should communicate realized, net yield rather than presenting a promised APY. At a hypothetical 4–6% annualized rate, `$8,000` produces roughly `$320–$480/year` before fees and losses; a weekly prize could therefore only be about `$6.15–$9.23` if all yield were used. Large prizes need accumulated yield, sponsorship, or a different economic model.

## Wallet finding

The app will use a provider boundary for both Privy and standard Solana wallets. Privy is not configured until an App ID is supplied; this repository accepts no credential and never creates or stores a user private key. A direct Solana-wallet flow remains the testable default.
