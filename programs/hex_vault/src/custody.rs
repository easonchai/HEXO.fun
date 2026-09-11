//! Pool lifecycle and Principal custody (spec §2.3 "Custody").
//!
//! `deposit` and `withdraw` are permissionless; every other instruction here
//! is authority-only via `has_one = authority` on the Pool account.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{BPS_DENOMINATOR, SEED_PLAYER, SEED_POOL, SEED_PRINCIPAL};
use crate::errors::HexVaultError;
use crate::events::{Deposited, ParamsSet, Paused, PoolCreated, Withdrawn};
use crate::state::{Player, Pool};
use crate::touch::touch;
use crate::utils;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolParams {
    pub pool_id: u64,
    pub vrf_network_state: Pubkey,
    pub epoch_seconds: i64,
    pub epoch_anchor: i64,
    pub round_seconds: i64,
    pub close_buffer: i64,
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub house_cut_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SetParamsArgs {
    pub epoch_seconds: Option<i64>,
    pub epoch_anchor: Option<i64>,
    pub round_seconds: Option<i64>,
    pub close_buffer: Option<i64>,
    pub vrf_timeout: Option<i64>,
    pub min_deposit: Option<u64>,
    pub house_cut_bps: Option<u16>,
}

pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
    require!(
        params.epoch_seconds > 0
            && params.epoch_anchor > 0
            && params.round_seconds > 0
            && params.vrf_timeout > 0,
        HexVaultError::InvalidParameter
    );
    require!(
        params.close_buffer >= 0 && params.close_buffer < params.round_seconds,
        HexVaultError::InvalidParameter
    );
    require!(
        params.house_cut_bps <= BPS_DENOMINATOR,
        HexVaultError::InvalidParameter
    );

    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    pool.pool_id = params.pool_id;
    pool.authority = ctx.accounts.authority.key();
    pool.accepted_mint = ctx.accounts.accepted_mint.key();
    pool.principal_vault = ctx.accounts.principal_vault.key();
    pool.jackpot_vault = ctx.accounts.jackpot_vault.key();
    pool.treasury = ctx.accounts.treasury.key();
    pool.buyback_reserve = ctx.accounts.buyback_reserve.key();
    pool.house = ctx.accounts.house.key();
    pool.vrf_network_state = params.vrf_network_state;
    pool.epoch_seconds = params.epoch_seconds;
    pool.epoch_anchor = params.epoch_anchor;
    pool.round_seconds = params.round_seconds;
    pool.close_buffer = params.close_buffer;
    pool.vrf_timeout = params.vrf_timeout;
    pool.min_deposit = params.min_deposit;
    pool.house_cut_bps = params.house_cut_bps;
    pool.paused = false;
    pool.current_epoch_id = 0;
    pool.current_epoch_start = 0;
    pool.current_epoch_ends_at = 0;
    pool.previous_epoch_start = 0;
    pool.previous_epoch_ends_at = 0;
    pool.next_round_id = 1;
    pool.open_round_id = 0;
    pool.carry_pot = 0;
    pool.total_principal = 0;
    pool.bump = ctx.bumps.pool;
    pool.principal_vault_bump = ctx.bumps.principal_vault;
    pool.jackpot_vault_bump = ctx.bumps.jackpot_vault;

    // The House holds no Principal and starts in epoch 0 like the pool
    // itself; `touch` brings it into epoch 1 the first time anything reads
    // or changes it, same as any other Player.
    let house = &mut ctx.accounts.house;
    house.owner = ctx.accounts.authority.key();
    house.principal = 0;
    house.entries = 0;
    house.weight_acc = 0;
    house.last_update = now;
    house.epoch_id = 0;
    house.frozen_weight = 0;
    house.frozen_epoch = 0;
    house.reg_epoch = 0;
    house.reg_start = 0;
    house.reg_end = 0;
    house.is_house = true;
    house.bump = ctx.bumps.house;

    emit!(PoolCreated {
        pool: pool.key(),
        pool_id: pool.pool_id,
        authority: pool.authority,
        accepted_mint: pool.accepted_mint,
    });
    Ok(())
}

pub fn set_params(ctx: Context<SetParams>, params: SetParamsArgs) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    if let Some(v) = params.epoch_seconds {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.epoch_seconds = v;
    }
    if let Some(v) = params.epoch_anchor {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.epoch_anchor = v;
    }
    if let Some(v) = params.round_seconds {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.round_seconds = v;
    }
    if let Some(v) = params.close_buffer {
        require!(
            v >= 0 && v < pool.round_seconds,
            HexVaultError::InvalidParameter
        );
        pool.close_buffer = v;
    }
    if let Some(v) = params.vrf_timeout {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.vrf_timeout = v;
    }
    if let Some(v) = params.min_deposit {
        pool.min_deposit = v;
    }
    if let Some(v) = params.house_cut_bps {
        require!(v <= BPS_DENOMINATOR, HexVaultError::InvalidParameter);
        pool.house_cut_bps = v;
    }

    emit!(ParamsSet {
        pool: pool.key(),
        epoch_seconds: pool.epoch_seconds,
        epoch_anchor: pool.epoch_anchor,
        round_seconds: pool.round_seconds,
        close_buffer: pool.close_buffer,
        vrf_timeout: pool.vrf_timeout,
        min_deposit: pool.min_deposit,
        house_cut_bps: pool.house_cut_bps,
    });
    Ok(())
}

pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.paused = paused;
    emit!(Paused {
        pool: pool.key(),
        paused,
    });
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let player = &mut ctx.accounts.player;

    // Seeds the fresh Player's clock before `touch`, or this is a no-op on
    // an existing one. Skipping this would make `touch` accrue weight from
    // the unix epoch instead of from now.
    player.init_if_fresh(ctx.accounts.owner.key(), pool, now, ctx.bumps.player);
    touch(player, pool, now)?;

    require!(!player.is_house, HexVaultError::HouseCannotDeposit);
    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(amount >= pool.min_deposit, HexVaultError::BelowMinimumDeposit);

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.principal_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    player.principal = player
        .principal
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.entries = player
        .entries
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.total_principal = pool
        .total_principal
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(Deposited {
        owner: ctx.accounts.owner.key(),
        amount,
        principal: player.principal,
        entries: player.entries,
    });
    Ok(())
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    touch(player, pool, now)?;

    // Invariant 3: withdraw is never blocked by `paused`.
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(player.principal >= amount, HexVaultError::InsufficientPrincipal);
    require!(player.entries >= amount, HexVaultError::InsufficientEntries);

    player.principal = player
        .principal
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.entries = player
        .entries
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.total_principal = pool
        .total_principal
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.principal_vault.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    emit!(Withdrawn {
        owner: ctx.accounts.owner.key(),
        amount,
        principal: player.principal,
        entries: player.entries,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: CreatePoolParams)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_POOL, &params.pool_id.to_le_bytes()],
        bump,
        space = 8 + Pool::INIT_SPACE,
    )]
    pub pool: Box<Account<'info, Pool>>,

    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [crate::constants::SEED_JACKPOT, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        seeds = [SEED_PLAYER, pool.key().as_ref(), authority.key().as_ref()],
        bump,
        space = 8 + Player::INIT_SPACE,
    )]
    pub house: Box<Account<'info, Player>>,

    #[account(
        constraint = treasury.mint == accepted_mint.key() @ HexVaultError::MintMismatch,
        constraint = treasury.owner == authority.key() @ HexVaultError::NotAuthorityOwned,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        constraint = buyback_reserve.mint == accepted_mint.key() @ HexVaultError::MintMismatch,
        constraint = buyback_reserve.owner == authority.key() @ HexVaultError::NotAuthorityOwned,
    )]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init_if_needed,
        payer = owner,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump,
        space = 8 + Player::INIT_SPACE,
    )]
    pub player: Account<'info, Player>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), owner.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
