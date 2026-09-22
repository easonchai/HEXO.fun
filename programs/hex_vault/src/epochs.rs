//! Epoch lifecycle (spec §2.3 "Epochs").
//!
//! `begin_epoch`, `close_registration`, `draw` and `rollover_epoch` are
//! operator-only via `has_one = operator` on the Pool account. `register`,
//! `fund_jackpot` and `payout` are permissionless.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{
    epoch_status, BPS_DENOMINATOR, SECONDS_PER_YEAR, SEED_EPOCH, SEED_JACKPOT, SEED_PLAYER,
    SEED_POOL, SEED_PRINCIPAL,
};
use crate::errors::HexVaultError;
use crate::events::{
    EpochBegan, EpochDrawn, EpochRolledOver, JackpotFunded, JackpotPaid, Registered, YieldCredited,
    YieldFunded,
};
use crate::state::{Epoch, Player, Pool};
use crate::touch::touch;
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

/// `principal_seconds × base_rate_bps / (10_000 × seconds_per_year)`, the
/// Base yield an ended epoch's principal-seconds earns before the budget
/// clamp. Floors like any integer division, so a span too short to earn a
/// whole atomic unit earns zero rather than rounding up.
fn yield_for(principal_seconds: u128, base_rate_bps: u16) -> Result<u64> {
    let numerator = principal_seconds
        .checked_mul(u128::from(base_rate_bps))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let denominator = u128::from(BPS_DENOMINATOR)
        .checked_mul(SECONDS_PER_YEAR)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let whole = numerator
        .checked_div(denominator)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    u64::try_from(whole).map_err(|_| HexVaultError::ArithmeticOverflow.into())
}

/// Weight and principal-seconds an ended epoch owes this player, the three
/// cases from spec §2.3. Read-only: registering never advances the player (a
/// later deposit/withdraw/touch/credit still owns that).
fn weight_and_principal_seconds(epoch: &Epoch, player: &Player) -> Result<(u128, u128)> {
    if player.epoch_id == epoch.epoch_id {
        // Not touched since the epoch ended: finish both accumulators with
        // the same math `touch` would use at the boundary, without mutating
        // the player (this player has not been touched since the epoch
        // ended).
        let tail = elapsed(player.last_update, epoch.ends_at);
        let w = player
            .weight_acc
            .checked_add(weight_of(player.entries, tail)?)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        let ps = player
            .principal_acc
            .checked_add(weight_of(player.principal, tail)?)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        Ok((w, ps))
    } else if player.epoch_id > epoch.epoch_id {
        // Touched again in a later epoch before registering for this one:
        // only the immediately-previous epoch's weight survives a touch, so
        // this only works if that was this exact epoch.
        require!(
            player.frozen_epoch == epoch.epoch_id,
            HexVaultError::FrozenEpochMismatch
        );
        Ok((player.frozen_weight, player.frozen_principal_acc))
    } else {
        // Idle through all of this epoch (and whatever came before it):
        // Entries equalled Principal for its entire length, so weight and
        // principal-seconds are the same figure.
        let idle = weight_of(player.principal, elapsed(epoch.starts_at, epoch.ends_at))?;
        Ok((idle, idle))
    }
}

/// Credits an ended epoch's Base yield into `player.principal`, `entries`
/// and `pool.total_principal`, clamped at `pool.yield_budget`. Returns
/// `(credited, shortfall)`.
///
/// When `credited > 0`, touches the player first, on the pre-credit balance,
/// so the credit only earns further weight and yield from the instant it
/// lands (`now`). Without this, a later idle-epoch calculation --
/// `register`'s own Branch A tail or Branch C idle span, or `touch`'s
/// boundary freeze -- would read the post-credit `principal` for a span that
/// started before the credit actually landed, over-crediting weight and
/// yield alike. This is the same hazard `payout`'s compounding has to close
/// by touching the winner before adding the prize.
fn credit_yield(pool: &mut Pool, player: &mut Player, ps: u128, now: i64) -> Result<(u64, u64)> {
    let desired = yield_for(ps, pool.base_rate_bps)?;
    let credited = desired.min(pool.yield_budget);
    let shortfall = desired
        .checked_sub(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    // The House holds no Principal, so its principal-seconds (and thus its
    // credit) is always zero; asserted rather than special-cased.
    debug_assert!(
        !player.is_house || credited == 0,
        "the House cannot earn yield"
    );

    // Only touch when a credit is actually about to change `principal`: an
    // empty budget (or the House's always-zero `ps`) mutates nothing, so
    // there is nothing to backdate and `register` keeps its promise that a
    // call crediting no yield never advances the player either.
    if credited > 0 {
        touch(player, pool, now)?;
    }

    player.principal = player
        .principal
        .checked_add(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.entries = player
        .entries
        .checked_add(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.total_principal = pool
        .total_principal
        .checked_add(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.yield_budget = pool
        .yield_budget
        .checked_sub(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    Ok((credited, shortfall))
}

/// Most recent point of the `anchor + k * period` grid at or before `t`.
///
/// `div_euclid` floors towards negative infinity. Plain `/` truncates
/// towards zero, which lands a whole period late for any `t` before the
/// anchor, and an anchor set to a future Sunday makes that the normal case.
fn grid_floor(anchor: i64, period: i64, t: i64) -> Result<i64> {
    let k = t
        .checked_sub(anchor)
        .ok_or(HexVaultError::ArithmeticOverflow)?
        .div_euclid(period);
    k.checked_mul(period)
        .and_then(|offset| anchor.checked_add(offset))
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
        // Registration only opens now, however late this call is, and
        // `close_registration` measures its window from here.
        previous.registration_opened_at = now;

        let mut buf = Vec::with_capacity(data.len());
        previous.try_serialize(&mut buf)?;
        require!(buf.len() <= data.len(), HexVaultError::ArithmeticOverflow);
        data[..buf.len()].copy_from_slice(&buf);

        // Contiguous when the operator is merely late, so the schedule
        // holds. Once the operator has been down past a whole grid point,
        // `grid_floor(now)` overtakes the previous end and the dead gap is
        // skipped: nobody accrued Weight in it (`touch` clamps at the
        // previous `ends_at`), so nothing is lost, and the boundary stays on
        // the grid instead of rerolling to `now`.
        previous_ends_at.max(grid_floor(pool.epoch_anchor, pool.epoch_seconds, now)?)
    };

    // The first epoch starts off grid at `now` and ends at the next grid
    // point, so it is a short stub and the pool is live from bootstrap.
    // Every epoch after it starts on the grid and runs a full period.
    let ends_at = grid_floor(pool.epoch_anchor, pool.epoch_seconds, starts_at)?
        .checked_add(pool.epoch_seconds)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    pool.previous_epoch_start = pool.current_epoch_start;
    pool.current_epoch_start = starts_at;
    pool.previous_epoch_ends_at = pool.current_epoch_ends_at;
    pool.current_epoch_ends_at = ends_at;
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
    new_epoch.drawn_at = 0;
    new_epoch.registration_opened_at = 0;
    new_epoch.version = crate::constants::CURRENT_VERSION;

    emit!(EpochBegan {
        epoch_id: new_epoch.epoch_id,
        starts_at,
        ends_at,
    });
    Ok(())
}

pub fn register(ctx: Context<Register>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
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

    // Weight and principal-seconds cases from spec §2.3. This deliberately
    // never calls `touch`: registering only reads what the player's state
    // implies, it does not advance it (a later deposit/withdraw/touch/credit
    // still owns that).
    let (w, ps) = weight_and_principal_seconds(epoch, player)?;

    // Base yield, credited once per Player per ended epoch regardless of
    // `w`: a Player who lost every Entry in a game still owns Principal and
    // still earns yield on it. Guarded separately from `reg_epoch`, which a
    // zero-weight registration below never sets, or a second permissionless
    // `register` call on such a Player would credit it twice.
    if player.yield_epoch != epoch.epoch_id {
        let now = utils::now()?;
        let (credited, shortfall) = credit_yield(pool, player, ps, now)?;
        player.yield_epoch = epoch.epoch_id;

        emit!(YieldCredited {
            epoch_id: epoch.epoch_id,
            owner: player.owner,
            amount: credited,
            shortfall,
        });
    }

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

/// Raises `yield_budget` by moving real USDC into the principal vault.
/// Permissionless like `fund_jackpot`: anyone can top up what Base yield
/// draws down.
pub fn fund_yield(ctx: Context<FundYield>, amount: u64) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.principal_vault.to_account_info(),
                authority: ctx.accounts.source_authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.yield_budget = pool
        .yield_budget
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(YieldFunded {
        amount,
        budget: pool.yield_budget,
    });
    Ok(())
}

pub fn close_registration(ctx: Context<CloseRegistration>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;

    require!(
        epoch.status == epoch_status::REGISTERING,
        HexVaultError::EpochNotRegistering
    );
    // Registration is permissionless and only opens when `begin_epoch` flips
    // this epoch to Registering, which the operator controls and can delay
    // past `ends_at`. Measuring from the later of the two means the window
    // is always a real window, not one the operator can have already spent.
    let opened = epoch.registration_opened_at.max(epoch.ends_at);
    let closes_at = opened
        .checked_add(pool.registration_window)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now >= closes_at, HexVaultError::RegistrationWindowOpen);

    // Whatever an epoch that has drawn but not paid still owes is not this
    // epoch's to snapshot, or two epochs would promise the same USDC and the
    // older one could never be paid.
    epoch.jackpot_amount = ctx
        .accounts
        .jackpot_vault
        .amount
        .saturating_sub(pool.jackpot_reserved);

    // Nothing to draw for, or too little to be worth drawing for: roll the
    // prize into the next epoch rather than spend a randomness request on it.
    if epoch.registered_weight == 0 || epoch.jackpot_amount < pool.min_jackpot {
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
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.vrf_network_state.to_account_info(),
        &ctx.accounts.vrf_treasury.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.vrf_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        seed,
    )?;

    epoch.status = epoch_status::DRAWING;
    epoch.requested_at = now;
    // The prize is now promised to this epoch until it pays or rolls over.
    pool.jackpot_reserved = pool
        .jackpot_reserved
        .checked_add(epoch.jackpot_amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    Ok(())
}

pub fn draw(ctx: Context<Draw>) -> Result<()> {
    let now = utils::now()?;
    let epoch = &mut ctx.accounts.epoch;

    require!(
        epoch.status == epoch_status::DRAWING,
        HexVaultError::EpochNotDrawing
    );

    let randomness = vrf::read_fulfilled(&ctx.accounts.randomness.to_account_info(), &epoch.vrf_seed)?;

    epoch.target = vrf::unbiased_u128(&randomness, epoch.registered_weight)?;
    epoch.status = epoch_status::DRAWN;
    epoch.drawn_at = now;

    emit!(EpochDrawn {
        epoch_id: epoch.epoch_id,
        target: epoch.target,
        registered_weight: epoch.registered_weight,
    });
    Ok(())
}

pub fn payout(ctx: Context<Payout>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;
    let winner = &mut ctx.accounts.winner;

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
    let is_house = winner.is_house;
    let decimals = ctx.accounts.accepted_mint.decimals;
    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    if is_house {
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
        // Compounds into the winner's Principal instead of paying their
        // token account: touch first, on the pre-prize balance, so the
        // prize only earns weight and yield from the instant it lands here
        // (the same hazard `register`'s yield credit closes against).
        let now = utils::now()?;
        touch(winner, pool, now)?;

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.jackpot_vault.to_account_info(),
                    mint: ctx.accounts.accepted_mint.to_account_info(),
                    to: ctx.accounts.principal_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            decimals,
        )?;

        winner.principal = winner
            .principal
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        winner.entries = winner
            .entries
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        pool.total_principal = pool
            .total_principal
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
    }

    epoch.winner = winner.owner;
    epoch.status = epoch_status::PAID;
    // Released whatever actually left the vault: a House win leaves 30% of
    // it behind, and that share belongs to the next epoch's snapshot.
    pool.jackpot_reserved = pool
        .jackpot_reserved
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(JackpotPaid {
        epoch_id: epoch.epoch_id,
        winner: winner.owner,
        amount,
        is_house,
        compounded: !is_house,
    });
    Ok(())
}

pub fn rollover_epoch(ctx: Context<RolloverEpoch>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let epoch = &mut ctx.accounts.epoch;

    match epoch.status {
        epoch_status::DRAWING => {
            // A fulfilled request has to go through `draw`, or the operator
            // could read the target, see who won, and wait out the timeout.
            require_keys_eq!(
                ctx.accounts.randomness.key(),
                vrf::randomness_address(&epoch.vrf_seed),
                HexVaultError::InvalidRandomnessAccount
            );
            require!(
                !vrf::is_fulfilled(&ctx.accounts.randomness.to_account_info(), &epoch.vrf_seed),
                HexVaultError::RandomnessAlreadyFulfilled
            );
            let deadline = epoch
                .requested_at
                .checked_add(pool.vrf_timeout)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            require!(now > deadline, HexVaultError::VrfTimeoutNotElapsed);
        }
        // The winner is known but cannot be paid: a frozen or closed token
        // account would otherwise leave this epoch open forever and hand its
        // prize to whoever wins the next one by accident. The jackpot stays
        // in the vault, so the next epoch draws for it deliberately.
        epoch_status::DRAWN => {
            let deadline = epoch
                .drawn_at
                .checked_add(pool.payout_timeout)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            require!(now > deadline, HexVaultError::PayoutTimeoutNotElapsed);
        }
        _ => return Err(HexVaultError::EpochNotDrawing.into()),
    }

    epoch.status = epoch_status::ROLLED_OVER;
    // Both branches above leave Drawing or Drawn, so the prize this epoch
    // was holding goes back into what the next close may snapshot.
    pool.jackpot_reserved = pool
        .jackpot_reserved
        .checked_sub(epoch.jackpot_amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(EpochRolledOver {
        epoch_id: epoch.epoch_id,
        jackpot_amount: epoch.jackpot_amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BeginEpoch<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = operator,
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
        payer = operator,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &(pool.current_epoch_id + 1).to_le_bytes()],
        bump,
        space = 8 + Epoch::INIT_SPACE,
    )]
    pub new_epoch: Account<'info, Epoch>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut, seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
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
pub struct FundYield<'info> {
    #[account(mut)]
    pub source_authority: Signer<'info>,

    #[account(mut, seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, token::mint = pool.accepted_mint, token::authority = source_authority)]
    pub source: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
    )]
    pub principal_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseRegistration<'info> {
    /// Pays ORAO's request fee and the request account's rent, so it must be
    /// writable.
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = operator,
    )]
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
    pub operator: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump, has_one = operator)]
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

/// No signer at all, like `process_withdraw`. The winner is fixed by the
/// Player PDA's seeds, so there is nothing here for a caller to steer.
/// Gating it on the operator only let the operator veto a winner by sitting
/// out `payout_timeout`. A non-House winner no longer needs a token account
/// of their own: the prize compounds into `principal_vault` instead.
#[derive(Accounts)]
pub struct Payout<'info> {
    // Boxed: unboxed, this struct's `try_accounts` overflows the BPF stack
    // frame (8 accounts including 5 token accounts).
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
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

    #[account(
        mut,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump = pool.principal_vault_bump,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RolloverEpoch<'info> {
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = operator,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_EPOCH, pool.key().as_ref(), &epoch.epoch_id.to_le_bytes()],
        bump = epoch.bump,
    )]
    pub epoch: Account<'info, Epoch>,

    /// CHECK: ORAO randomness account for this epoch's draw, matched against
    /// `vrf::randomness_address` in the handler the same way `draw` does.
    /// Only read on the Drawing branch, where an unfulfilled (or absent)
    /// account is the normal case.
    pub randomness: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600;
    const DAY: i64 = 86_400;
    const WEEK: i64 = 604_800;
    /// Sunday 2026-09-13T16:00:00Z, which is 00:00 Monday in UTC+8.
    const SUNDAY_1600: i64 = 1_789_315_200;

    #[test]
    fn a_t_already_on_the_grid_returns_itself() {
        assert_eq!(grid_floor(1_000, 60, 1_000).expect("grid"), 1_000);
        assert_eq!(grid_floor(1_000, 60, 1_240).expect("grid"), 1_240);
        assert_eq!(
            grid_floor(SUNDAY_1600, DAY, SUNDAY_1600 + 5 * DAY).expect("grid"),
            SUNDAY_1600 + 5 * DAY
        );
    }

    #[test]
    fn a_t_before_the_anchor_floors_down_not_towards_zero() {
        // Truncating division gives 1_000 for all three, a whole period late
        // and after `t`, which is what `div_euclid` is here to avoid.
        assert_eq!(grid_floor(1_000, 60, 999).expect("grid"), 940);
        assert_eq!(grid_floor(1_000, 60, 941).expect("grid"), 940);
        assert_eq!(grid_floor(1_000, 60, 940).expect("grid"), 940);
        assert_eq!(
            grid_floor(SUNDAY_1600, DAY, SUNDAY_1600 - 1).expect("grid"),
            SUNDAY_1600 - DAY
        );
    }

    #[test]
    fn the_daily_grid_from_a_sunday_anchor_lands_on_1600_utc_all_week() {
        // 57_600 seconds into the UTC day is 16:00, which is midnight in
        // UTC+8. Probes run a week either side of the anchor.
        for hour in -168..168 {
            let t = SUNDAY_1600 + hour * HOUR;
            let point = grid_floor(SUNDAY_1600, DAY, t).expect("grid");
            assert_eq!(point.rem_euclid(DAY), 57_600, "hour {hour} left 16:00 UTC");
            assert!(point <= t && t - point < DAY, "hour {hour} is not the floor");
        }
    }

    #[test]
    fn the_weekly_grid_from_the_same_anchor_lands_on_sundays() {
        // 316_800 seconds into the unix week (which starts on a Thursday) is
        // Sunday 16:00 UTC, so one anchor serves the daily and weekly grids.
        for hour in -168..168 {
            let t = SUNDAY_1600 + hour * HOUR;
            let point = grid_floor(SUNDAY_1600, WEEK, t).expect("grid");
            assert_eq!(point.rem_euclid(WEEK), 316_800, "hour {hour} left Sunday");
            assert!(point <= t && t - point < WEEK, "hour {hour} is not the floor");
        }
    }

    // --- `weight_and_principal_seconds` / `credit_yield` (hexo-referrals
    // ticket 02): ticket 01 only closed the retroactive-attribution gap for
    // a player already touched into the pool's current epoch. These check
    // the idle-player path ticket 01 left open.

    fn pool_at(id: u64, start: i64, base_rate_bps: u16, yield_budget: u64) -> Pool {
        Pool {
            pool_id: 1,
            admin: Pubkey::default(),
            operator: Pubkey::default(),
            pending_admin: Pubkey::default(),
            accepted_mint: Pubkey::default(),
            principal_vault: Pubkey::default(),
            jackpot_vault: Pubkey::default(),
            treasury: Pubkey::default(),
            buyback_reserve: Pubkey::default(),
            house: Pubkey::default(),
            vrf_network_state: Pubkey::default(),
            epoch_seconds: DAY,
            epoch_anchor: 1,
            round_seconds: 60,
            close_buffer: 5,
            vrf_timeout: 120,
            min_deposit: 1,
            house_cut_bps: 0,
            paused: false,
            current_epoch_id: id,
            current_epoch_start: start,
            current_epoch_ends_at: start + DAY,
            previous_epoch_start: start - DAY,
            previous_epoch_ends_at: start,
            next_round_id: 1,
            open_round_id: 0,
            carry_pot: 0,
            total_principal: 0,
            bump: 0,
            principal_vault_bump: 0,
            jackpot_vault_bump: 0,
            pending_withdrawals: 0,
            min_jackpot: 1_000_000,
            registration_window: 0,
            payout_timeout: DAY,
            jackpot_reserved: 0,
            base_rate_bps,
            yield_budget,
            tickets_per_usdc: 10,
            bonus_cap_bps: 500,
            bonus_epoch: 0,
            bonus_granted: 0,
            version: 1,
            _reserved: [0; 128],
        }
    }

    fn epoch_at(epoch_id: u64, starts_at: i64, ends_at: i64) -> Epoch {
        Epoch {
            epoch_id,
            starts_at,
            ends_at,
            status: epoch_status::REGISTERING,
            registered_weight: 0,
            registered_count: 0,
            jackpot_amount: 0,
            vrf_seed: [0u8; 32],
            requested_at: 0,
            target: 0,
            winner: Pubkey::default(),
            bump: 0,
            drawn_at: 0,
            registration_opened_at: 0,
            version: 1,
            _reserved: [0; 64],
        }
    }

    fn player(principal: u64, entries: u64, epoch_id: u64, last_update: i64) -> Player {
        Player {
            owner: Pubkey::new_unique(),
            principal,
            entries,
            weight_acc: 0,
            last_update,
            epoch_id,
            frozen_weight: 0,
            frozen_epoch: 0,
            reg_epoch: 0,
            reg_start: 0,
            reg_end: 0,
            is_house: false,
            bump: 0,
            pending_withdraw: 0,
            pending_epoch: 0,
            requested_at: 0,
            principal_acc: 0,
            frozen_principal_acc: 0,
            yield_epoch: 0,
            bought_epoch: 0,
            bought_amount: 0,
            bonus_epoch: 0,
            bonus_granted: 0,
            version: 1,
            _reserved: [0; 64],
        }
    }

    #[test]
    fn credit_yield_touches_before_crediting_so_a_later_idle_span_does_not_backdate_it() {
        // A player idle since before epoch 1 is credited by `register(1)` a
        // little late (100s into epoch 2, as a delayed operator crank would
        // run it), then never touched before `register(2)` reads epoch 2's
        // idle span. Without touching the player at credit time (ticket 01
        // only did this when the player was already touched into the pool's
        // current epoch), that idle span treats the epoch-1 credit as if it
        // had sat in `principal` since epoch 2's own start, over-counting
        // principal-seconds -- and therefore weight and yield -- by
        // `credited * 100`.
        let principal: u64 = 1_000_000_000;
        let epoch1 = epoch_at(1, 0, DAY);
        let mut p = player(principal, principal, 0, 0);

        let (_, ps1) = weight_and_principal_seconds(&epoch1, &p).expect("epoch 1 ps");
        assert_eq!(
            ps1,
            u128::from(principal) * DAY as u128,
            "idle for all of epoch 1"
        );

        let mut pool = pool_at(2, DAY, 488, u64::MAX);
        let credit_at = DAY + 100; // 100s into epoch 2: the crank ran late
        let (credited1, shortfall1) =
            credit_yield(&mut pool, &mut p, ps1, credit_at).expect("credit 1");
        assert_eq!(shortfall1, 0);
        assert!(
            credited1 > 0,
            "the rate and span must actually earn something"
        );
        assert_eq!(
            p.epoch_id, 2,
            "touch rolled the player into the pool's current epoch"
        );
        assert_eq!(p.last_update, credit_at);

        // Epoch 2 is later registered once it, too, has ended.
        let epoch2 = epoch_at(2, DAY, 2 * DAY);
        let (_, ps2) = weight_and_principal_seconds(&epoch2, &p).expect("epoch 2 ps");

        let post_credit_principal = u128::from(principal) + u128::from(credited1);
        let correct = u128::from(principal) * 100 + post_credit_principal * (DAY as u128 - 100);
        let backdated = post_credit_principal * DAY as u128; // the over-count this test guards against

        assert_eq!(
            ps2, correct,
            "only the time after the credit landed may use the larger, post-credit balance"
        );
        assert!(
            ps2 < backdated,
            "must not attribute the epoch-1 credit to time before it landed in epoch 2"
        );
    }

    #[test]
    fn credit_yield_never_credits_the_house() {
        let epoch1 = epoch_at(1, 0, DAY);
        let mut house = player(0, 0, 0, 0);
        house.is_house = true;

        let (_, ps) = weight_and_principal_seconds(&epoch1, &house).expect("epoch 1 ps");
        assert_eq!(ps, 0, "the House holds no Principal");

        let mut pool = pool_at(2, DAY, 488, u64::MAX);
        let (credited, shortfall) =
            credit_yield(&mut pool, &mut house, ps, DAY + 1).expect("credit");
        assert_eq!(credited, 0);
        assert_eq!(shortfall, 0);
        assert_eq!(house.principal, 0);
    }

    #[test]
    fn credit_yield_does_not_touch_when_the_budget_credits_nothing() {
        // register() must stay read-only for a Player whose credit is 0 (an
        // empty budget): a later natural touch (deposit/withdraw) still owns
        // rolling epoch_id/weight_acc forward, exactly as it does for a
        // Player earning no yield at all.
        let principal: u64 = 1_000_000_000;
        let epoch1 = epoch_at(1, 0, DAY);
        let mut p = player(principal, principal, 0, 0);

        let (_, ps1) = weight_and_principal_seconds(&epoch1, &p).expect("epoch 1 ps");
        let mut pool = pool_at(2, DAY, 488, 0); // empty budget
        let (credited, shortfall) =
            credit_yield(&mut pool, &mut p, ps1, DAY + 100).expect("credit");

        assert_eq!(credited, 0);
        assert!(shortfall > 0);
        assert_eq!(p.epoch_id, 0, "untouched: nothing was actually credited");
        assert_eq!(p.last_update, 0);
    }
}
