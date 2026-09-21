//! Pool lifecycle and Principal custody (spec §2.3 "Custody").
//!
//! `deposit`, `request_withdraw` and `process_withdraw` are permissionless.
//! `set_params`, `set_operator`, `propose_admin`, `admin_withdraw` and
//! unpausing are admin-only via `has_one = admin` on the Pool account;
//! pausing takes the admin or the operator, so `SetPause` names its signer
//! `signer` and the handler decides.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::spl_token;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::{BPS_DENOMINATOR, SEED_JACKPOT, SEED_PLAYER, SEED_POOL, SEED_PRINCIPAL};
use crate::errors::HexVaultError;
use crate::events::{
    AdminChanged, AdminProposed, Deposited, OperatorChanged, ParamsSet, Paused, PoolCreated,
    PrincipalDeployed, TicketsBought, WithdrawRequested, Withdrawn,
};
use crate::state::{Player, Pool};
use crate::touch::touch;
use crate::utils;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolParams {
    pub pool_id: u64,
    /// Role keys, not accounts: neither has to sign `create_pool`, and on
    /// mainnet the admin is a multisig that cannot.
    pub admin: Pubkey,
    pub operator: Pubkey,
    pub vrf_network_state: Pubkey,
    pub epoch_seconds: i64,
    pub epoch_anchor: i64,
    pub round_seconds: i64,
    pub close_buffer: i64,
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub house_cut_bps: u16,
    pub min_jackpot: u64,
    pub registration_window: i64,
    pub payout_timeout: i64,
    /// Base yield's APR in basis points, capped at `BPS_DENOMINATOR`.
    pub base_rate_bps: u16,
    /// Tickets credited per USDC spent in `buy_tickets`. Must be > 0.
    pub tickets_per_usdc: u16,
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
    pub min_jackpot: Option<u64>,
    pub registration_window: Option<i64>,
    pub payout_timeout: Option<i64>,
    pub base_rate_bps: Option<u16>,
    pub tickets_per_usdc: Option<u16>,
}

pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
    // Nobody holds the default key, so either of these would brick every
    // admin path (or every crank) on a pool that cannot be fixed afterwards.
    require!(
        params.admin != Pubkey::default() && params.operator != Pubkey::default(),
        HexVaultError::InvalidParameter
    );
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
    require!(
        params.base_rate_bps <= BPS_DENOMINATOR,
        HexVaultError::InvalidParameter
    );
    require!(
        params.tickets_per_usdc > 0,
        HexVaultError::InvalidParameter
    );
    require!(
        params.registration_window >= 0 && params.registration_window < params.epoch_seconds,
        HexVaultError::InvalidParameter
    );
    // Zero would let the operator roll a Drawn epoch over in the same block
    // it was drawn in, which is the thing `payout_timeout` exists to stop.
    require!(params.payout_timeout > 0, HexVaultError::InvalidParameter);
    // Transfer-fee and other Token-2022 extensions would break the
    // vault-balance arithmetic every payout depends on, so only the classic
    // program's mints are accepted.
    require!(
        ctx.accounts.accepted_mint.to_account_info().owner == &spl_token::ID,
        HexVaultError::UnsupportedMint
    );

    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    pool.pool_id = params.pool_id;
    pool.admin = params.admin;
    pool.operator = params.operator;
    pool.pending_admin = Pubkey::default();
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
    pool.min_jackpot = params.min_jackpot;
    pool.registration_window = params.registration_window;
    pool.payout_timeout = params.payout_timeout;
    pool.pending_withdrawals = 0;
    pool.jackpot_reserved = 0;
    pool.base_rate_bps = params.base_rate_bps;
    pool.yield_budget = 0;
    pool.tickets_per_usdc = params.tickets_per_usdc;
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
    house.owner = params.operator;
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
    house.pending_withdraw = 0;
    house.pending_epoch = 0;
    house.requested_at = 0;

    emit!(PoolCreated {
        pool: pool.key(),
        pool_id: pool.pool_id,
        admin: pool.admin,
        operator: pool.operator,
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
    if let Some(v) = params.min_jackpot {
        pool.min_jackpot = v;
    }
    if let Some(v) = params.registration_window {
        pool.registration_window = v;
    }
    if let Some(v) = params.payout_timeout {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.payout_timeout = v;
    }
    if let Some(v) = params.base_rate_bps {
        require!(v <= BPS_DENOMINATOR, HexVaultError::InvalidParameter);
        pool.base_rate_bps = v;
    }
    if let Some(v) = params.tickets_per_usdc {
        require!(v > 0, HexVaultError::InvalidParameter);
        pool.tickets_per_usdc = v;
    }
    // Checked on the result rather than in the branch above, so shortening
    // `epoch_seconds` in the same call cannot leave a window that swallows a
    // whole epoch, whichever of the two the caller passes.
    require!(
        pool.registration_window >= 0 && pool.registration_window < pool.epoch_seconds,
        HexVaultError::InvalidParameter
    );

    emit!(ParamsSet {
        pool: pool.key(),
        epoch_seconds: pool.epoch_seconds,
        epoch_anchor: pool.epoch_anchor,
        round_seconds: pool.round_seconds,
        close_buffer: pool.close_buffer,
        vrf_timeout: pool.vrf_timeout,
        min_deposit: pool.min_deposit,
        house_cut_bps: pool.house_cut_bps,
        min_jackpot: pool.min_jackpot,
        registration_window: pool.registration_window,
        payout_timeout: pool.payout_timeout,
        base_rate_bps: pool.base_rate_bps,
        tickets_per_usdc: pool.tickets_per_usdc,
    });
    Ok(())
}

pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let signer = ctx.accounts.signer.key();
    // Pausing is the emergency stop, so the hot operator key reaches it too.
    // Coming back out is an admin decision, which is why this cannot be a
    // plain `has_one` on the account struct.
    let allowed = signer == pool.admin || (paused && signer == pool.operator);
    require!(allowed, HexVaultError::Unauthorized);

    pool.paused = paused;
    emit!(Paused {
        pool: pool.key(),
        paused,
    });
    Ok(())
}

pub fn set_operator(ctx: Context<SetOperator>, new_operator: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let previous = pool.operator;
    pool.operator = new_operator;
    emit!(OperatorChanged {
        pool: pool.key(),
        previous,
        operator: new_operator,
    });
    Ok(())
}

/// Half a handover. Calling it again replaces the pending proposal, and
/// proposing `Pubkey::default()` cancels one.
pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.pending_admin = new_admin;
    emit!(AdminProposed {
        pool: pool.key(),
        pending_admin: new_admin,
    });
    Ok(())
}

/// The other half, signed by the proposed key, so a typo in `propose_admin`
/// leaves the pool with the admin it already had.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(
        pool.pending_admin != Pubkey::default(),
        HexVaultError::NoPendingAdmin
    );
    require_keys_eq!(
        ctx.accounts.pending_admin.key(),
        pool.pending_admin,
        HexVaultError::Unauthorized
    );

    let previous = pool.admin;
    pool.admin = pool.pending_admin;
    pool.pending_admin = Pubkey::default();
    emit!(AdminChanged {
        pool: pool.key(),
        previous,
        admin: pool.admin,
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
    require!(
        amount >= pool.min_deposit,
        HexVaultError::BelowMinimumDeposit
    );

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

/// Books a withdrawal without moving any USDC (ADR 0009). The principal is
/// lent out for most of the epoch, so the transfer waits for
/// `process_withdraw` after the epoch this request was made in has ended.
///
/// A second request while one is still pending merges into it and re-stamps
/// `pending_epoch`, so an unpaid earlier request slides to the later epoch.
/// The operator pays every due request at each epoch start, so that only
/// costs a depositor who requests again before the first payout landed.
pub fn request_withdraw(ctx: Context<RequestWithdraw>, amount: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    touch(player, pool, now)?;

    // Invariant 3: a withdrawal is never blocked by `paused`.
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(
        player.principal >= amount,
        HexVaultError::InsufficientPrincipal
    );

    player.principal = player
        .principal
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // No `entries >= amount` rule: the payout lands after the boundary where
    // Entries would have reset to Principal anyway, so a player who lost
    // every Entry in rounds is not locked out for an extra epoch. Entries
    // may exceed Principal pool-wide until that boundary.
    player.entries = player.entries.saturating_sub(amount);
    pool.total_principal = pool
        .total_principal
        .checked_sub(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    player.pending_withdraw = player
        .pending_withdraw
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    pool.pending_withdrawals = pool
        .pending_withdrawals
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.pending_epoch = pool.current_epoch_id;
    player.requested_at = now;

    emit!(WithdrawRequested {
        owner: ctx.accounts.owner.key(),
        amount,
        pending: player.pending_withdraw,
        pending_epoch: player.pending_epoch,
    });
    Ok(())
}

/// Pays a matured request. No signer at all: the operator pushes these every
/// epoch, and the depositor (or anyone) can push their own if it does not.
pub fn process_withdraw(ctx: Context<ProcessWithdraw>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let player = &mut ctx.accounts.player;

    let pending = player.pending_withdraw;
    require!(pending > 0, HexVaultError::NothingPending);
    // Either the epoch the request was made in has been left behind, or a
    // whole epoch's worth of seconds has passed since the request. The
    // second can never come first while the operator is alive, because the
    // epoch the request landed in ends within `epoch_seconds` of it; it is
    // the escape hatch for an operator that stopped calling `begin_epoch`.
    let deadline = player
        .requested_at
        .checked_add(pool.epoch_seconds)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(
        pool.current_epoch_id > player.pending_epoch || now > deadline,
        HexVaultError::WithdrawalNotDue
    );
    // Checked before anything is written, so a vault still waiting on the
    // yield venue leaves the request exactly as it was for the next attempt.
    require!(
        ctx.accounts.principal_vault.amount >= pending,
        HexVaultError::InsufficientVaultLiquidity
    );

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
        pending,
        ctx.accounts.accepted_mint.decimals,
    )?;

    player.pending_withdraw = 0;
    pool.pending_withdrawals = pool
        .pending_withdrawals
        .checked_sub(pending)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(Withdrawn {
        owner: player.owner,
        amount: pending,
        principal: player.principal,
        entries: player.entries,
    });
    Ok(())
}

/// Sends principal to the admin's own associated token account so it can be
/// lent off-program (ADR 0010). `total_principal` is untouched: depositor
/// claims do not change with where the USDC is sitting, and readers derive
/// the deployed amount as `total_principal - vault.amount`. Bringing it back
/// is a plain SPL transfer into the vault, with no instruction behind it.
pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
    let pool = &ctx.accounts.pool;
    require!(amount > 0, HexVaultError::ZeroAmount);

    // Two different failures: the vault does not hold this much at all, and
    // the vault holds it but depositors have already asked for part of it.
    let remaining = ctx
        .accounts
        .principal_vault
        .amount
        .checked_sub(amount)
        .ok_or(HexVaultError::InsufficientVaultLiquidity)?;
    require!(
        remaining >= pool.pending_withdrawals,
        HexVaultError::BelowPendingWithdrawals
    );

    let pool_id_bytes = pool.pool_id.to_le_bytes();
    let pool_bump = [pool.bump];
    let signer_seeds: &[&[u8]] = &[SEED_POOL, &pool_id_bytes, &pool_bump];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.principal_vault.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.admin_token.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    emit!(PrincipalDeployed {
        pool: pool.key(),
        amount,
        vault_remaining: remaining,
    });
    Ok(())
}

/// Resets `bought_amount` to 0 when `bought_epoch` is not `current_epoch_id`,
/// adds `amount`, and checks the result against `principal`. Returns the new
/// `bought_amount`; the caller still owns stamping `bought_epoch`.
fn bought_amount_after(
    bought_epoch: u64,
    bought_amount: u64,
    current_epoch_id: u64,
    principal: u64,
    amount: u64,
) -> Result<u64> {
    let base = if bought_epoch == current_epoch_id {
        bought_amount
    } else {
        0
    };
    let total = base
        .checked_add(amount)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    // Also covers "principal > 0": with amount > 0 already required by the
    // caller, a zero Principal fails this the same way an already-spent cap
    // would.
    require!(total <= principal, HexVaultError::DailyBuyCapExceeded);
    Ok(total)
}

/// Spends real USDC on extra Tickets at a fixed price (spec "Bought
/// tickets"). The USDC goes to the jackpot vault and is never returned; the
/// Tickets are ordinary Entries from the moment they land.
///
/// Capped per Player per epoch at `principal`, checked against the live
/// balance at call time rather than a start-of-day snapshot. `principal` only
/// falls when a withdrawal is requested, so a `request_withdraw` before a
/// `buy_tickets` can only tighten this player's remaining allowance for the
/// epoch, never raise it, and `bought_amount` is never reset by anything but
/// an epoch change, so re-depositing withdrawn principal cannot reopen room
/// the player already spent. `pool.current_epoch_id` is well-defined for the
/// whole registration window too (it already points at the new epoch by
/// then), so buying during that window is just an ordinary purchase against
/// the new day's cap, not a way to buy twice against the epoch that just
/// closed.
pub fn buy_tickets(ctx: Context<BuyTickets>, amount: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    // Touches on the pre-purchase balance before entries change below, the
    // same rule credit_yield and payout's compounding follow: otherwise a
    // later idle-epoch span could read the post-purchase entries for time
    // that predates the purchase (ticket 02's Comments).
    touch(player, pool, now)?;

    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(amount > 0, HexVaultError::ZeroAmount);
    require!(!player.is_house, HexVaultError::HouseCannotBuyTickets);

    let bought_amount = bought_amount_after(
        player.bought_epoch,
        player.bought_amount,
        pool.current_epoch_id,
        player.principal,
        amount,
    )?;
    player.bought_epoch = pool.current_epoch_id;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.accepted_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.accepted_mint.decimals,
    )?;

    let tickets = amount
        .checked_mul(u64::from(pool.tickets_per_usdc))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.bought_amount = bought_amount;
    player.entries = player
        .entries
        .checked_add(tickets)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    emit!(TicketsBought {
        owner: player.owner,
        epoch_id: pool.current_epoch_id,
        usdc: amount,
        tickets,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: CreatePoolParams)]
pub struct CreatePool<'info> {
    /// Pays rent only. The admin and operator come in through `params`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_POOL, &params.pool_id.to_le_bytes()],
        bump,
        space = 8 + Pool::INIT_SPACE,
    )]
    pub pool: Box<Account<'info, Pool>>,

    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_PRINCIPAL, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [crate::constants::SEED_JACKPOT, pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [SEED_PLAYER, pool.key().as_ref(), params.operator.as_ref()],
        bump,
        space = 8 + Player::INIT_SPACE,
    )]
    pub house: Box<Account<'info, Player>>,

    // Only the mint is checked. On mainnet these are the multisig's own
    // accounts, which nothing in this instruction signs for.
    #[account(constraint = treasury.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(constraint = buyback_reserve.mint == accepted_mint.key() @ HexVaultError::MintMismatch)]
    pub buyback_reserve: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    /// Admin or operator. Which one is allowed depends on the direction, so
    /// the handler checks it rather than a `has_one` here.
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    /// Checked in the handler against `pool.pending_admin`, so an unset
    /// proposal fails with `NoPendingAdmin` instead of a constraint error.
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
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

/// No token accounts: the request moves nothing.
#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
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
}

#[derive(Accounts)]
pub struct ProcessWithdraw<'info> {
    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Seeded from its own `owner`, which is what makes this safe without a
    /// signer: the destination below has to belong to that same owner.
    #[account(
        mut,
        seeds = [SEED_PLAYER, pool.key().as_ref(), player.owner.as_ref()],
        bump = player.bump,
    )]
    pub player: Box<Account<'info, Player>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = accepted_mint,
        token::authority = player.owner,
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

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(address = pool.accepted_mint @ HexVaultError::MintMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Checked by address, not just by owner: a fat-fingered destination
    /// fails here rather than landing somewhere the admin has to chase.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &admin.key(),
            &accepted_mint.key(),
            &token_program.key(),
        ) @ HexVaultError::InvalidAdminTokenAccount,
    )]
    pub admin_token: Box<InterfaceAccount<'info, TokenAccount>>,

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

#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Must already exist: a Player only has a cap to buy against once it
    /// holds Principal.
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
        seeds = [SEED_JACKPOT, pool.key().as_ref()],
        bump = pool.jackpot_vault_bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_purchase_landing_exactly_on_the_cap_succeeds() {
        let bought = bought_amount_after(1, 700, 1, 1_000, 300).expect("at cap");
        assert_eq!(bought, 1_000);
    }

    #[test]
    fn one_more_than_the_cap_fails() {
        assert!(bought_amount_after(1, 700, 1, 1_000, 301)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }

    #[test]
    fn a_new_epoch_resets_the_counter_instead_of_carrying_it_over() {
        // Spent the whole cap in epoch 1; epoch 2 starts fresh even though
        // `bought_amount` on the Player still reads 1_000 from yesterday.
        let bought = bought_amount_after(1, 1_000, 2, 1_000, 1_000).expect("fresh epoch");
        assert_eq!(bought, 1_000);
    }

    #[test]
    fn zero_principal_fails_like_an_exhausted_cap() {
        // The House, or any Player who has never deposited: `principal > 0`
        // is folded into the same check rather than a separate require.
        assert!(bought_amount_after(0, 0, 1, 0, 1)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }

    #[test]
    fn a_request_withdraw_between_two_buys_only_tightens_the_remaining_room() {
        // Same epoch throughout: 1_000 principal, 400 already bought. A
        // request_withdraw drops principal to 500 before the next buy is
        // checked, so at most 100 more clears -- never more than the
        // original 1_000 cap, whichever order the two instructions land in.
        let after_withdraw = bought_amount_after(1, 400, 1, 500, 100).expect("still room");
        assert_eq!(after_withdraw, 500);
        assert!(bought_amount_after(1, 400, 1, 500, 101)
            .unwrap_err()
            .to_string()
            .contains("exceed today's cap"));
    }
}
