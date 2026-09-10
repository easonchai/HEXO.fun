//! Account layouts. Fixed by `docs/plan/rebuild/spec.md` §2.1 — changing a
//! field here churns the IDL, the indexer's Prisma schema, and the frontend.

use anchor_lang::prelude::*;

use crate::constants::TILE_COUNT;
use crate::errors::HexVaultError;

/// One deployed instance of the product: one accepted mint, one principal
/// vault, one jackpot vault, one epoch schedule.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u64,
    /// Operator key. Also the House Player's owner and the mint authority.
    pub authority: Pubkey,
    pub accepted_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub jackpot_vault: Pubkey,
    /// Authority-owned token account: 20% of a jackpot the House wins.
    pub treasury: Pubkey,
    /// Authority-owned token account: 50% of a jackpot the House wins.
    pub buyback_reserve: Pubkey,
    /// The House `Player` PDA, created in `create_pool`.
    pub house: Pubkey,
    /// ORAO VRF network state, pinned at pool creation.
    pub vrf_network_state: Pubkey,
    /// Applies to the next epoch created, not the open one.
    pub epoch_seconds: i64,
    /// Fixes the phase of the epoch grid `epoch_anchor + k * epoch_seconds`.
    /// Every epoch boundary is a point on it, so the draw lands at the same
    /// clock time whatever second the pool was bootstrapped on.
    pub epoch_anchor: i64,
    /// Applies to the next round created, not the open one.
    pub round_seconds: i64,
    /// Positions stop this many seconds before a round ends.
    pub close_buffer: i64,
    /// Seconds after a randomness request before void / rollover is allowed.
    pub vrf_timeout: i64,
    pub min_deposit: u64,
    pub paused: bool,
    /// 0 before the first epoch.
    pub current_epoch_id: u64,
    pub current_epoch_start: i64,
    /// End of the current epoch, copied from its `Epoch.ends_at`. `touch`
    /// reads it instead of adding `epoch_seconds`, so changing that
    /// parameter never moves an epoch that has already begun.
    pub current_epoch_ends_at: i64,
    /// Start of the epoch before the current one. Usually that is
    /// `current_epoch_start` too, except when `begin_epoch` skipped a gap.
    pub previous_epoch_start: i64,
    /// End of the epoch before the current one, where `touch` freezes the
    /// weight a player earned in it.
    pub previous_epoch_ends_at: i64,
    pub next_round_id: u64,
    /// 0 when no round is Open or Requested.
    pub open_round_id: u64,
    /// Entries carried out of a voided round into the next round's pot.
    pub carry_pot: u64,
    pub total_principal: u64,
    pub bump: u8,
    pub principal_vault_bump: u8,
    pub jackpot_vault_bump: u8,
}

/// One lottery cycle. Contiguous: the next opens the moment this one ends.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    /// [`EpochStatus`]
    pub status: u8,
    pub registered_weight: u128,
    pub registered_count: u32,
    /// Jackpot vault balance snapshotted at `close_registration`.
    pub jackpot_amount: u64,
    pub vrf_seed: [u8; 32],
    pub requested_at: i64,
    /// Point in `registered_weight` selected by the draw.
    pub target: u128,
    pub winner: Pubkey,
    pub bump: u8,
}

/// One 60 second game on the 36-tile hex board.
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    /// [`RoundStatus`]
    pub status: u8,
    pub tile_totals: [u64; TILE_COUNT as usize],
    /// Entries staked in this round plus any carry from a voided round.
    pub pot: u64,
    pub vrf_seed: [u8; 32],
    pub requested_at: i64,
    pub winning_tile: u8,
    pub bump: u8,
}

/// One wallet's account in one pool.
#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    /// 1:1 claim on deposited USDC. Never at risk.
    pub principal: u64,
    /// Lottery weight units. Moved between players by the game.
    pub entries: u64,
    /// Σ entries × seconds within `epoch_id`.
    pub weight_acc: u128,
    pub last_update: i64,
    /// The epoch `weight_acc` belongs to.
    pub epoch_id: u64,
    /// Final weight for `frozen_epoch`, set by [`crate::touch::touch`].
    pub frozen_weight: u128,
    pub frozen_epoch: u64,
    /// Epoch this player is registered for. `reg_start`/`reg_end` are its
    /// interval in that epoch's `registered_weight`.
    pub reg_epoch: u64,
    pub reg_start: u128,
    pub reg_end: u128,
    pub is_house: bool,
    pub bump: u8,
}

/// A Player's single immutable placement in one round.
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub round: Pubkey,
    /// Bitmask, bits 0..35.
    pub tiles: u64,
    pub stake_per_tile: u64,
    pub bump: u8,
}

impl Player {
    /// Fills a freshly `init_if_needed`ed account. A no-op on an existing
    /// one, so callers can run it unconditionally before `touch`.
    ///
    /// Without this a new Player has `last_update = 0`, and `touch` would
    /// accrue weight from the unix epoch.
    pub fn init_if_fresh(&mut self, owner: Pubkey, pool: &Pool, now: i64, bump: u8) {
        if self.owner != Pubkey::default() {
            return;
        }
        self.owner = owner;
        self.last_update = now;
        self.epoch_id = pool.current_epoch_id;
        self.bump = bump;
    }
}

impl Round {
    pub fn tile_total(&self, tile: u8) -> Result<u64> {
        require!(tile < TILE_COUNT, HexVaultError::InvalidTileSelection);
        Ok(self.tile_totals[tile as usize])
    }

    pub fn add_to_tile(&mut self, tile: u8, amount: u64) -> Result<()> {
        require!(tile < TILE_COUNT, HexVaultError::InvalidTileSelection);
        let slot = &mut self.tile_totals[tile as usize];
        *slot = slot
            .checked_add(amount)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        Ok(())
    }
}
