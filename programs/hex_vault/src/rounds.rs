//! Round lifecycle (spec §2.3 "Rounds").
//!
//! `create_round`, `settle_round` and `void_round` are authority-only via
//! `has_one = authority` on the Pool account. `buy_position`,
//! `request_round_randomness` and `settle_position` are permissionless.

use anchor_lang::prelude::*;

use crate::constants::{round_status, SEED_EPOCH, SEED_PLAYER, SEED_POOL, SEED_POSITION, SEED_ROUND, TILE_COUNT};
use crate::errors::HexVaultError;
use crate::events::{PositionBought, PositionSettled, RoundOpened, RoundSettled, RoundVoided};
use crate::state::{Epoch, Player, Pool, Position, Round};
use crate::touch::touch;
use crate::utils;
use crate::vrf;

pub fn create_round(ctx: Context<CreateRound>, starts_at: i64, ends_at: i64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    require!(!pool.paused, HexVaultError::PoolPaused);
    require!(pool.open_round_id == 0, HexVaultError::RoundAlreadyOpen);
    require!(
        ends_at.checked_sub(starts_at) == Some(pool.round_seconds),
        HexVaultError::InvalidRoundLength
    );

    // Bound the round to the current epoch. Before the first epoch begins
    // (`current_epoch_id == 0`) there is nothing to bound against yet, and
    // no Epoch account exists at that id, so the check (and the
    // `current_epoch` account) is skipped entirely in that case.
    if pool.current_epoch_id != 0 {
        let expected_epoch = Pubkey::find_program_address(
            &[
                SEED_EPOCH,
                pool.key().as_ref(),
                &pool.current_epoch_id.to_le_bytes(),
            ],
            &crate::ID,
        )
        .0;
        require_keys_eq!(
            ctx.accounts.current_epoch.key(),
            expected_epoch,
            HexVaultError::InvalidParameter
        );
        let data = ctx.accounts.current_epoch.try_borrow_data()?;
        let epoch = Epoch::try_deserialize(&mut &data[..])?;
        require!(ends_at <= epoch.ends_at, HexVaultError::RoundOutsideEpoch);
    }

    let round_id = pool.next_round_id;
    pool.next_round_id = pool
        .next_round_id
        .checked_add(1)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let pot = pool.carry_pot;
    pool.carry_pot = 0;
    pool.open_round_id = round_id;
    let epoch_id = pool.current_epoch_id;
    let vrf_seed = utils::vrf_seed(b"round", &pool.key(), round_id);

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.epoch_id = epoch_id;
    round.starts_at = starts_at;
    round.ends_at = ends_at;
    round.status = round_status::OPEN;
    round.tile_totals = [0; TILE_COUNT as usize];
    round.pot = pot;
    round.vrf_seed = vrf_seed;
    round.requested_at = 0;
    round.winning_tile = 0;
    round.bump = ctx.bumps.round;

    emit!(RoundOpened {
        round_id,
        epoch_id,
        starts_at,
        ends_at,
        carry_in: pot,
    });
    Ok(())
}

pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let player = &mut ctx.accounts.player;
    touch(player, pool, now)?;

    let round = &mut ctx.accounts.round;
    require!(round.status == round_status::OPEN, HexVaultError::RoundNotOpen);
    let close_at = round
        .ends_at
        .checked_sub(pool.close_buffer)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now < close_at, HexVaultError::RoundClosed);

    let tile_count = utils::tile_count(tiles)?;
    require!(stake_per_tile >= 1, HexVaultError::InvalidStake);
    let total = stake_per_tile
        .checked_mul(tile_count)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(player.entries >= total, HexVaultError::InsufficientEntries);

    // Pre-credit the Weight this stake would have earned for the rest of the
    // round before it leaves Entries, so buying a position is Weight-neutral
    // for the lottery draw (spec §2.3).
    let remaining = round
        .ends_at
        .checked_sub(now)
        .and_then(|s| u64::try_from(s).ok())
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    let credited = u128::from(total)
        .checked_mul(u128::from(remaining))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    player.weight_acc = player
        .weight_acc
        .checked_add(credited)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    player.entries = player
        .entries
        .checked_sub(total)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    for tile in 0..TILE_COUNT {
        if utils::tile_is_covered(tiles, tile) {
            round.add_to_tile(tile, stake_per_tile)?;
        }
    }
    round.pot = round
        .pot
        .checked_add(total)
        .ok_or(HexVaultError::ArithmeticOverflow)?;

    let round_id = round.round_id;
    let round_key = round.key();

    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.owner.key();
    position.round = round_key;
    position.tiles = tiles;
    position.stake_per_tile = stake_per_tile;
    position.bump = ctx.bumps.position;

    emit!(PositionBought {
        round_id,
        owner: ctx.accounts.owner.key(),
        tiles,
        stake_per_tile,
        total,
    });
    Ok(())
}

pub fn request_round_randomness(ctx: Context<RequestRoundRandomness>) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(round.status == round_status::OPEN, HexVaultError::RoundNotOpen);
    require!(now >= round.ends_at, HexVaultError::RoundNotEnded);

    require_keys_eq!(
        ctx.accounts.randomness.key(),
        vrf::randomness_address(&pool.vrf_network_state, &round.vrf_seed),
        HexVaultError::InvalidRandomnessAccount
    );

    vrf::request_randomness(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.vrf_network_state.to_account_info(),
        &ctx.accounts.randomness.to_account_info(),
        &ctx.accounts.vrf_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        round.vrf_seed,
    )?;

    round.status = round_status::REQUESTED;
    round.requested_at = now;
    Ok(())
}

pub fn settle_round(ctx: Context<SettleRound>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(
        round.status == round_status::REQUESTED,
        HexVaultError::RoundNotRequested
    );

    let randomness = vrf::read_fulfilled(
        &ctx.accounts.randomness.to_account_info(),
        &pool.vrf_network_state,
        &round.vrf_seed,
    )?;

    // u64 sample mapped into 0..36 via the rejection-sampled unbiased
    // mapping (bias bound documented on `vrf::unbiased_u64`); the result is
    // always < 36 so the cast to u8 is lossless.
    let winning_tile = vrf::unbiased_u64(&randomness, u64::from(TILE_COUNT))? as u8;

    let pot = round.pot;
    let tile_total = round.tile_total(winning_tile)?;
    let forfeited = tile_total == 0;

    if forfeited {
        let house = &mut ctx.accounts.house;
        touch(house, pool, now)?;
        house.entries = house
            .entries
            .checked_add(pot)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        round.status = round_status::FORFEITED;
    } else {
        round.status = round_status::SETTLED;
    }
    round.winning_tile = winning_tile;
    pool.open_round_id = 0;

    let round_id = round.round_id;
    emit!(RoundSettled {
        round_id,
        winning_tile,
        pot,
        forfeited,
    });
    Ok(())
}

pub fn settle_position(ctx: Context<SettlePosition>) -> Result<()> {
    let now = utils::now()?;
    let pool = &ctx.accounts.pool;
    let round = &ctx.accounts.round;
    let player = &mut ctx.accounts.player;
    touch(player, pool, now)?;

    require!(
        matches!(
            round.status,
            round_status::SETTLED | round_status::FORFEITED | round_status::VOIDED
        ),
        HexVaultError::RoundNotSettled
    );

    let position = &ctx.accounts.position;
    let mut reward: u64 = 0;
    if round.status == round_status::SETTLED
        && utils::tile_is_covered(position.tiles, round.winning_tile)
    {
        // tile_total is > 0 here: settle_round only reaches Settled (rather
        // than Forfeited) when some position covers winning_tile, and this
        // one does, so it contributed at least stake_per_tile to it.
        let tile_total = round.tile_total(round.winning_tile)?;
        let reward_u128 = u128::from(round.pot)
            .checked_mul(u128::from(position.stake_per_tile))
            .ok_or(HexVaultError::ArithmeticOverflow)?
            / u128::from(tile_total);
        // Integer division truncates towards zero; the remainder stays
        // unminted. Negligible dust, documented and accepted (spec §2.3).
        reward = u64::try_from(reward_u128).map_err(|_| HexVaultError::ArithmeticOverflow)?;
    }

    if reward > 0 {
        player.entries = player
            .entries
            .checked_add(reward)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
    }

    emit!(PositionSettled {
        round_id: round.round_id,
        owner: position.owner,
        reward,
    });
    Ok(())
}

pub fn void_round(ctx: Context<VoidRound>) -> Result<()> {
    let now = utils::now()?;
    let pool = &mut ctx.accounts.pool;
    let round = &mut ctx.accounts.round;

    require!(
        round.status == round_status::REQUESTED,
        HexVaultError::RoundNotRequested
    );
    let timeout_at = round
        .requested_at
        .checked_add(pool.vrf_timeout)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(now > timeout_at, HexVaultError::VrfTimeoutNotElapsed);

    pool.carry_pot = pool
        .carry_pot
        .checked_add(round.pot)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    round.status = round_status::VOIDED;
    pool.open_round_id = 0;

    let round_id = round.round_id;
    let carry_pot = pool.carry_pot;
    emit!(RoundVoided { round_id, carry_pot });
    Ok(())
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

    /// CHECK: the pool's current epoch. Only read (and its address checked)
    /// when one is open (`pool.current_epoch_id != 0`); any account may be
    /// passed before the first epoch begins, since there is nothing yet to
    /// bound `ends_at` against.
    pub current_epoch: UncheckedAccount<'info>,

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

    /// CHECK: ORAO randomness account for this round's seed, verified
    /// against `vrf::randomness_address` in the handler.
    #[account(mut)]
    pub randomness: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF network state, pinned on the pool at `create_pool`.
    #[account(address = pool.vrf_network_state)]
    pub vrf_network_state: UncheckedAccount<'info>,

    /// CHECK: ORAO VRF program.
    #[account(address = vrf::ORAO_VRF_PROGRAM_ID)]
    pub vrf_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleRound<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,

    /// CHECK: ORAO randomness account for this round's seed, verified
    /// against `vrf::randomness_address` (via `vrf::read_fulfilled`) using
    /// `pool.vrf_network_state`.
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
        constraint = position.owner == player.owner @ HexVaultError::InvalidParameter,
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct VoidRound<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_POOL, &pool.pool_id.to_le_bytes()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [SEED_ROUND, pool.key().as_ref(), &round.round_id.to_le_bytes()],
        bump = round.bump,
    )]
    pub round: Account<'info, Round>,
}
