//! HexVault: a no-loss lottery with zero-sum hex rounds (see `CONTEXT.md`
//! and `docs/plan/rebuild/spec.md`).
//!
//! This module only declares instructions and delegates to their owning
//! module. Custody (`create_pool`, `set_params`, `set_pause`, `deposit`,
//! `withdraw`) is implemented in `custody.rs`. Rounds and epochs are stubs
//! here on purpose: their accounts are final so the IDL does not churn, but
//! their bodies land in tickets 03 and 04, entirely inside `rounds.rs` and
//! `epochs.rs` so this file never needs to change again for them.

pub mod constants;
pub mod custody;
pub mod epochs;
pub mod errors;
pub mod events;
pub mod rounds;
pub mod state;
#[cfg(feature = "test-vrf")]
pub mod test_vrf;
pub mod touch;
pub mod utils;
pub mod vrf;

use anchor_lang::prelude::*;

use custody::*;
use epochs::*;
use rounds::*;
#[cfg(feature = "test-vrf")]
use test_vrf::*;

declare_id!("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");

#[program]
pub mod hex_vault {
    use super::*;

    // Custody (spec §2.3 "Custody")

    pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
        custody::create_pool(ctx, params)
    }

    pub fn set_params(ctx: Context<SetParams>, params: SetParamsArgs) -> Result<()> {
        custody::set_params(ctx, params)
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        custody::set_pause(ctx, paused)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        custody::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        custody::withdraw(ctx, amount)
    }

    // Rounds (spec §2.3 "Rounds") - stubs, ticket 03 implements these.

    pub fn create_round(ctx: Context<CreateRound>, starts_at: i64, ends_at: i64) -> Result<()> {
        rounds::create_round(ctx, starts_at, ends_at)
    }

    pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
        rounds::buy_position(ctx, tiles, stake_per_tile)
    }

    pub fn request_round_randomness(ctx: Context<RequestRoundRandomness>) -> Result<()> {
        rounds::request_round_randomness(ctx)
    }

    pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
        rounds::settle_round(ctx)
    }

    pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
        rounds::settle_position(ctx)
    }

    pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
        rounds::void_round(ctx)
    }

    // Epochs (spec §2.3 "Epochs") - stubs, ticket 04 implements these.

    pub fn begin_epoch(ctx: Context<BeginEpoch>) -> Result<()> {
        epochs::begin_epoch(ctx)
    }

    pub fn register(ctx: Context<Register>) -> Result<()> {
        epochs::register(ctx)
    }

    pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
        epochs::fund_jackpot(ctx, amount)
    }

    pub fn close_registration(ctx: Context<CloseRegistration>) -> Result<()> {
        epochs::close_registration(ctx)
    }

    pub fn draw(ctx: Context<Draw>) -> Result<()> {
        epochs::draw(ctx)
    }

    pub fn payout(ctx: Context<Payout>) -> Result<()> {
        epochs::payout(ctx)
    }

    pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
        epochs::rollover_epoch(ctx)
    }

    // Localnet only (spec §2.5): fabricates a fulfilled ORAO randomness
    // account so tests never need a deployed VRF program.
    #[cfg(feature = "test-vrf")]
    pub fn test_fulfill(
        ctx: Context<TestFulfill>,
        seed: [u8; 32],
        randomness: [u8; 64],
    ) -> Result<()> {
        test_vrf::test_fulfill(ctx, seed, randomness)
    }
}
