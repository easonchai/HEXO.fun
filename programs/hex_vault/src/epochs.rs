//! Epoch lifecycle (spec §2.3 "Epochs"). Stub for ticket 02: accounts are
//! wired up so the IDL is stable, instruction bodies land in ticket 04.
#![allow(unused_variables)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

use crate::constants::{SEED_EPOCH, SEED_JACKPOT, SEED_PLAYER, SEED_POOL};
use crate::state::{Epoch, Player, Pool};

pub fn begin_epoch(ctx: Context<BeginEpoch>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn register(ctx: Context<Register>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn close_registration(ctx: Context<CloseRegistration>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn draw(ctx: Context<Draw>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn payout(ctx: Context<Payout>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
    todo!("epoch lifecycle - ticket 04")
}

#[derive(Accounts)]
pub struct BeginEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,

    /// The epoch that just ended, moved to Registering. Does not exist yet
    /// on the very first call (`pool.current_epoch_id == 0`); ticket 04
    /// owns that bootstrap case.
    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &pool.current_epoch_id.to_le_bytes()],
        bump = current_epoch.bump,
    )]
    pub current_epoch: Account<'info, Epoch>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &(pool.current_epoch_id + 1).to_le_bytes()],
        bump,
        space = 8 + Epoch::INIT_SPACE,
    )]
    pub new_epoch: Account<'info, Epoch>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct FundJackpot<'info> {
    #[account(mut)]
    pub source_authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, token::mint = pool.accepted_mint, token::authority = source_authority)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
    )]
    pub jackpot_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseRegistration<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    #[account(
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
    )]
    pub jackpot_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: ORAO randomness account for this epoch's draw.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF network state, pinned on the pool at `create_pool`.
    pub vrf_network_state: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF program. Ticket 03/04 nails down the exact CPI
    /// account list and instruction discriminator.
    pub vrf_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Draw<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    /// CHECK: ORAO randomness account for this epoch's draw.
    pub randomness: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    pub authority: Signer<'info>,

    // Boxed: unboxed, this struct's `try_accounts` overflows the BPF stack
    // frame (7 accounts including 4 token accounts).
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
        has_one = treasury,
        has_one = buyback_reserve,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Box<Account<'info, Epoch>>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), winner.owner.as_ref()],
        bump = winner.bump,
    )]
    pub winner: Box<Account<'info, Player>>,

    #[account(
        mut,
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.accepted_mint, token::authority = winner.owner)]
    pub winner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RolloverEpoch<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = authority)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,
}
