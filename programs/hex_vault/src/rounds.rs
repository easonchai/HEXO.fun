//! Round lifecycle (spec §2.3 "Rounds"). Stub for ticket 02: accounts are
//! wired up so the IDL is stable, instruction bodies land in ticket 03.
#![allow(unused_variables)]

use anchor_lang::prelude::*;

use crate::constants::{SEED_PLAYER, SEED_POOL, SEED_POSITION, SEED_ROUND};
use crate::state::{Player, Pool, Position, Round};

pub fn create_round(ctx: Context<CreateRound>, starts_at: i64, ends_at: i64) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

pub fn request_round_randomness(ctx: Context<RequestRoundRandomness>) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
    todo!("round lifecycle - ticket 03")
}

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_ROUND, pool.key().as_ref(), &pool.next_round_id.to_le_bytes()],
        bump,
        space = 8 + Round::INIT_SPACE,
    )]
    pub round: Account<'info, Round>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        init,
        payer = owner,
        seeds = [SEED_POSITION, round.key().as_ref(), owner.key().as_ref()],
        bump,
        space = 8 + Position::INIT_SPACE,
    )]
    pub position: Account<'info, Position>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRoundRandomness<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: ORAO randomness account for this round's seed. Ticket 03
    /// verifies its address with `vrf::randomness_address` before use.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF network state, pinned on the pool at `create_pool`.
    pub vrf_network_state: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF program. Ticket 03 nails down the exact CPI account
    /// list and instruction discriminator against the deployed program.
    pub vrf_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: ORAO randomness account for this round's seed.
    pub randomness: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), house.owner.as_ref()],
        bump = house.bump,
    )]
    pub house: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,

    /// CHECK: rent destination for the closed Position; must be its owner.
    #[account(mut, address = position.owner)]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [SEED_POSITION, round.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct VoidRound<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}
