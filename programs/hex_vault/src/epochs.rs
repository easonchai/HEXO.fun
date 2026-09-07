//! Epoch lifecycle (spec §2.3 "Epochs").
//!
//! `begin_epoch`, `close_registration`, `draw`, `payout` and `rollover_epoch`
//! are authority-only via `has_one = authority` on the Pool account.
//! `register` and `fund_jackpot` are permissionless.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{epoch_status, SEED_EPOCH, SEED_JACKPOT, SEED_PLAYER, SEED_POOL};
use crate::errors::HexVaultError;
use crate::events::{
    EpochBegan, EpochDrawn, EpochRolledOver, JackpotFunded, JackpotPaid, Registered,
};
use crate::state::{Epoch, Player, Pool};
use crate::utils;
use crate::vrf;

/// Seconds between two instants, clamped at zero. Mirrors `touch::elapsed`;
/// duplicated here because that one is private to its module and registering
/// never touches a player (spec §2.3), so it has no reason to import it.
fn elapsed(from: i64, to: i64) -> u128 {
    u128::from(u64::try_from(to.saturating_sub(from)).unwrap_or(0))
}

fn weight_of(entries: u64, seconds: u128) -> Result<u128> {
    u128::from(entries)
        .checked_mul(seconds)
        .ok_or_else(|| HexVaultError::ArithmeticOverflow.into())
}

pub fn begin_epoch(ctx: Context<BeginEpoch>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;

    let starts_at = if pool.current_epoch_id == 0 {
        now
    } else {
        // The epoch that just ended. Read and rewrite it through raw
        // account data (like `test_vrf::test_fulfill` does) instead of
        // `Account::try_from`: the account is `UncheckedAccount` so a
        // first-ever call, where it doesn't exist yet, never tries to
        // deserialize it, and `Account<'info, T>` from a re-borrowed
        // `UncheckedAccount` cannot satisfy the matching lifetimes
        // `try_from` requires without naming a lifetime on this handler
        // that the `#[program]`-generated wrapper in `lib.rs` cannot match.
        let mut data = ctx.accounts.current_epoch.try_borrow_mut_data()?;
        let mut previous = Epoch::try_deserialize(&mut &data[..])?;
        require!(now >= previous.ends_at, HexVaultError::EpochNotEnded);
        let previous_ends_at = previous.ends_at;
        previous.status = epoch_status::REGISTERING;

        let mut buf = Vec::with_capacity(data.len());
        previous.try_serialize(&mut buf)?;
        data[..buf.len()].copy_from_slice(&buf);

        // Contiguous when the operator is merely late, so the schedule holds.
        // A whole epoch or more late (the operator was down), chaining would
        // open an epoch that has already ended, and every Round would wait
        // while the crank replays the backlog one epoch at a time. Skip the
        // gap instead: nobody accrued Weight in it (`touch` clamps at the
        // previous `ends_at`), so nothing is lost.
        let whole_epoch_late = previous_ends_at
            .checked_add(pool.epoch_seconds)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        if now >= whole_epoch_late {
            now
        } else {
            previous_ends_at
        }
    };

    let ends_at = starts_at
        .checked_add(pool.epoch_seconds)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    pool.previous_epoch_start = pool.current_epoch_start;
    pool.current_epoch_start = starts_at;
    pool.current_epoch_id = pool
        .current_epoch_id
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    let new_epoch = &mut ctx.accounts.new_epoch;
    new_epoch.epoch_id = pool.current_epoch_id;
    new_epoch.starts_at = starts_at;
    new_epoch.ends_at = ends_at;
    new_epoch.status = epoch_status::OPEN;
    new_epoch.registered_weight = 0;
    new_epoch.registered_count = 0;
    new_epoch.jackpot_amount = 0;
    new_epoch.vrf_seed = [0u8; 32];
    new_epoch.requested_at = 0;
    new_epoch.target = 0;
    new_epoch.winner = Pubkey::default();
    new_epoch.bump = ctx.bumps.new_epoch;

    emit!(EpochBegan {
        epoch_id: new_epoch.epoch_id,
        starts_at,
        ends_at,
    });
    Ok(())
}

pub fn register(ctx: Context<Register>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;
    let player = &mut ctx.accounts.player;

    require!(
        epoch.status == epoch_status::REGISTERING,
        HexVaultError::EpochNotRegistering
    );
    require!(
        pool.current_epoch_id > 0 && epoch.epoch_id == pool.current_epoch_id - 1,
        HexVaultError::NotPreviousEpoch
    );
    require!(
        player.reg_epoch != epoch.epoch_id,
        HexVaultError::AlreadyRegistered
    );

    // Weight cases from spec §2.3. This deliberately never calls `touch`:
    // registering only reads what the player's state implies, it does not
    // advance it (a later deposit/withdraw/touch still owns that).
    let w = if player.epoch_id == epoch.epoch_id {
        // Not touched since the epoch ended: finish its accumulator with the
        // same math `touch` would use at the boundary, without mutating the
        // player (this player has not been touched since the epoch ended).
        player
            .weight_acc
            .checked_add(weight_of(
                player.entries,
                elapsed(player.last_update, epoch.ends_at),
            )?)
            .ok_or(HexVaultError::ArithmeticOverflow)?
    } else if player.epoch_id > epoch.epoch_id {
        // Touched again in a later epoch before registering for this one:
        // only the immediately-previous epoch's weight survives a touch, so
        // this only works if that was this exact epoch.
        require!(
            player.frozen_epoch == epoch.epoch_id,
            HexVaultError::FrozenEpochMismatch
        );
        player.frozen_weight
    } else {
        // Idle through all of this epoch (and whatever came before it):
        // Entries equalled Principal for its entire length.
        weight_of(player.principal, elapsed(epoch.starts_at, epoch.ends_at))?
    };

    if w == 0 {
        return Ok(());
    }

    let reg_start = epoch.registered_weight;
    let reg_end = reg_start
        .checked_add(w)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    player.reg_epoch = epoch.epoch_id;
    player.reg_start = reg_start;
    player.reg_end = reg_end;
    epoch.registered_weight = reg_end;
    epoch.registered_count = epoch
        .registered_count
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(Registered {
        epoch_id: epoch.epoch_id,
        owner: player.owner,
        weight: w,
        reg_start,
        reg_end,
    });
    Ok(())
}

pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.source_authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    emit!(JackpotFunded {
        source: ctx.accounts.source.key(),
        amount,
    });
    Ok(())
}

pub fn close_registration(ctx: Context<CloseRegistration>) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;

    require!(
        epoch.status == epoch_status::REGISTERING,
        HexVaultError::EpochNotRegistering
    );

    epoch.jackpot_amount = ctx.accounts.jackpot_vault.amount;

    if epoch.registered_weight == 0 {
        epoch.status = epoch_status::ROLLED_OVER;
        emit!(EpochRolledOver {
            epoch_id: epoch.epoch_id,
            jackpot_amount: epoch.jackpot_amount,
        });
        return Ok(());
    }

    let seed = utils::vrf_seed(b"epoch", &pool.key(), epoch.epoch_id);
    epoch.vrf_seed = seed;

    vrf::request_randomness(
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.vrf_network_state.to_account_info(),
        &ctx.accounts.vrf_treasury.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.vrf_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        seed,
    )?;

    epoch.status = epoch_status::DRAWING;
    epoch.requested_at = now;
    Ok(())
}

pub fn draw(ctx: Context<Draw>) -> Result<()> {
    let epoch = &mut ctx.accounts.epoch;

    require!(
        epoch.status == epoch_status::DRAWING,
        HexVaultError::EpochNotDrawing
    );

    let randomness = vrf::read_fulfilled(&ctx.accounts.randomness.to_account_info(), &epoch.vrf_seed)?;

    epoch.target = vrf::unbiased_u128(&randomness, epoch.registered_weight)?;
    epoch.status = epoch_status::DRAWN;

    emit!(EpochDrawn {
        epoch_id: epoch.epoch_id,
        target: epoch.target,
        registered_weight: epoch.registered_weight,
    });
    Ok(())
}

pub fn payout(ctx: Context<Payout>) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;
    let winner = &ctx.accounts.winner;

    require!(
        epoch.status == epoch_status::DRAWN,
        HexVaultError::EpochNotDrawn
    );
    require!(
        winner.reg_epoch == epoch.epoch_id,
        HexVaultError::NotRegistered
    );
    require!(
        winner.reg_start <= epoch.target && epoch.target < winner.reg_end,
        HexVaultError::NotTheWinner
    );

    let amount = epoch.jackpot_amount;
    let decimals = ctx.accounts.accepted_mint.decimals;
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    if winner.is_house {
        // 50/20/30 split (spec §7); the 30% share and any dust from the
        // truncating divisions below simply stay in the jackpot vault.
        let buyback_amount = amount / 2;
        let treasury_amount = amount / 5;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.jackpot_vault.to_account_info(),
                    mint: ctx.accounts.accepted_mint.to_account_info(),
                    to: ctx.accounts.buyback_reserve.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            buyback_amount,
            decimals,
        )?;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.jackpot_vault.to_account_info(),
                    mint: ctx.accounts.accepted_mint.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            treasury_amount,
            decimals,
        )?;
    } else {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.jackpot_vault.to_account_info(),
                    mint: ctx.accounts.accepted_mint.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            decimals,
        )?;
    }

    epoch.winner = winner.owner;
    epoch.status = epoch_status::PAID;

    emit!(JackpotPaid {
        epoch_id: epoch.epoch_id,
        winner: winner.owner,
        amount,
        is_house: winner.is_house,
    });
    Ok(())
}

pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;

    require!(
        epoch.status == epoch_status::DRAWING,
        HexVaultError::EpochNotDrawing
    );
    let deadline = epoch
        .requested_at
        .checked_add(pool.vrf_timeout)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now > deadline, HexVaultError::VrfTimeoutNotElapsed);

    epoch.status = epoch_status::ROLLED_OVER;

    emit!(EpochRolledOver {
        epoch_id: epoch.epoch_id,
        jackpot_amount: epoch.jackpot_amount,
    });
    Ok(())
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

    /// CHECK: the epoch that just ended, moved to Registering. Does not
    /// exist yet on the very first call (`pool.current_epoch_id == 0`); the
    /// handler skips it entirely in that case, so it is never deserialized
    /// before it exists.
    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &pool.current_epoch_id.to_le_bytes()],
        bump,
    )]
    pub current_epoch: UncheckedAccount<'info>,

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

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

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
    /// Pays ORAO's request fee and the request account's rent, so it must be
    /// writable.
    #[account(mut)]
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

    /// CHECK: ORAO randomness account for this epoch's draw. Its address
    /// depends on the seed this instruction computes, so unlike `draw`
    /// (which reads `epoch.vrf_seed` back) there is nothing to check it
    /// against yet; `draw` is what actually verifies it.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF network state, pinned on the pool at `create_pool`.
    /// `mut` because `request_v2` increments its `num_received`: the CPI marks
    /// it writable, and an outer context that is not cannot grant that.
    #[account(mut, address = pool.vrf_network_state @ HexVaultError::InvalidRandomnessAccount)]
    pub vrf_network_state: UncheckedAccount<'info>,

    /// CHECK: ORAO's fee treasury (`network_state.config.treasury`). ORAO
    /// rejects any other account, so it is only forwarded here.
    #[account(mut)]
    pub vrf_treasury: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF program.
    #[account(address = vrf::ORAO_VRF_PROGRAM_ID)]
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
    // frame (8 accounts including 5 token accounts).
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
        has_one = treasury,
        has_one = buyback_reserve,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

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
