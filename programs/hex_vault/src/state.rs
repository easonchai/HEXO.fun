//! Account layouts. Fixed by `docs/plan/rebuild/spec.md` §2.1 — changing a
//! field here churns the IDL, the indexer's Prisma schema, and the frontend.

use anchor_lang::prelude::*;

use crate::constants::{CURRENT_VERSION, TILE_COUNT};
use crate::errors::HexVaultError;

/// One deployed instance of the product: one accepted mint, one principal
/// vault, one jackpot vault, one epoch schedule.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u64,
    /// Changes parameters, unpauses, rotates the operator, and hands its own
    /// role on. A multisig on mainnet.
    pub admin: Pubkey,
    /// The hot key the operator service cranks with. Also the House Player's
    /// owner and, on devnet, the mint authority.
    pub operator: Pubkey,
    /// Proposed next admin. `Pubkey::default()` means no handover is open.
    pub pending_admin: Pubkey,
    pub accepted_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub jackpot_vault: Pubkey,
    /// Token account that takes 20% of a jackpot the House wins.
    pub treasury: Pubkey,
    /// Token account that takes 50% of a jackpot the House wins.
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
    /// Share of every settled round pot credited to the House, in basis
    /// points, 0..=10_000. Applies to the next round settled.
    pub house_cut_bps: u16,
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
    /// Σ `Player.pending_withdraw` across the pool. `admin_withdraw` refuses
    /// to leave the principal vault holding less than this.
    pub pending_withdrawals: u64,
    /// An epoch whose jackpot vault holds less than this at
    /// `close_registration` rolls over instead of paying out dust.
    pub min_jackpot: u64,
    /// Seconds after an epoch's `ends_at` during which `close_registration`
    /// is refused, so the operator cannot draw before everyone who earned
    /// weight in that epoch has been registered. `0 <= this < epoch_seconds`.
    pub registration_window: i64,
    /// Seconds after `Epoch.drawn_at` before a Drawn epoch may be rolled
    /// over unpaid. The escape hatch for a winner nobody can pay.
    pub payout_timeout: i64,
    /// Jackpot already promised to an epoch that is Drawing or Drawn and has
    /// not paid yet. `close_registration` snapshots the vault minus this, so
    /// the next epoch cannot take a prize the previous one still owes.
    /// Released on `payout` and on either branch of `rollover_epoch`.
    pub jackpot_reserved: u64,
    /// Base yield's APR on time-weighted Principal, in basis points, capped
    /// at `BPS_DENOMINATOR`. An admin parameter, so it can change without a
    /// program upgrade.
    pub base_rate_bps: u16,
    /// USDC already in the principal vault, earmarked for Base yield and not
    /// yet credited to anyone. `fund_yield` raises it; `register` draws it
    /// down and never credits past what it holds.
    pub yield_budget: u64,
    /// Tickets credited per USDC spent in `buy_tickets`. An admin parameter,
    /// always greater than zero.
    pub tickets_per_usdc: u16,
    /// Share of `total_principal`, in basis points, an operator
    /// `grant_tickets` call may credit pool-wide per epoch. An admin
    /// parameter, capped at `BPS_DENOMINATOR`.
    pub bonus_cap_bps: u16,
    /// The epoch `bonus_granted` is counted against, reset the same way as
    /// `Player.bought_epoch`/`bought_amount`.
    pub bonus_epoch: u64,
    /// Tickets an operator `grant_tickets` call has credited pool-wide so far
    /// in `bonus_epoch`, capped at `total_principal * bonus_cap_bps /
    /// 10_000`. An admin grant does not count against it.
    pub bonus_granted: u64,
    /// Set to [`CURRENT_VERSION`] by `create_pool`. Lets a future upgrade
    /// tell an old account apart from a freshly created one and migrate it
    /// lazily on first touch.
    pub version: u8,
    /// Admin-only and irreversible (spec "Shutdown"). Stops every inflow,
    /// the game and the draw, and lets withdrawals skip the epoch lock.
    /// Carved from the front of `_reserved` (ops-and-envs ticket 02),
    /// exercising the ADR 0013 rule once: `false` is the safe zero value.
    pub shutdown: bool,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013.
    pub _reserved: [u8; 127],
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
    /// When `draw` landed. 0 until then. `rollover_epoch` measures
    /// `Pool.payout_timeout` from here.
    pub drawn_at: i64,
    /// When `begin_epoch` moved this epoch to Registering, which is when
    /// anyone could first register for it. 0 until then.
    /// `close_registration` measures `Pool.registration_window` from the
    /// later of this and `ends_at`, so an operator who delays `begin_epoch`
    /// cannot bundle the whole registration window into one transaction.
    pub registration_opened_at: i64,
    /// Set to [`CURRENT_VERSION`] by `begin_epoch`. See `Pool::version`.
    pub version: u8,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013.
    pub _reserved: [u8; 64],
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
    /// Stays gross: the House cut is never subtracted from it.
    pub pot: u64,
    /// Entries taken out of `pot` for the House at settlement. 0 until then,
    /// and on forfeited or voided rounds.
    pub house_cut: u64,
    pub vrf_seed: [u8; 32],
    pub requested_at: i64,
    pub winning_tile: u8,
    pub bump: u8,
    /// Positions bought on this round still open (not yet settled).
    /// Incremented in `buy_position`, decremented when `settle_position`
    /// closes its Position. `close_round` refuses while this is nonzero.
    /// No `_reserved` to carve this from: Round has none by design (spec),
    /// since it is short-lived and reclaimed by `close_round` (ops-and-envs
    /// ticket 05), so a layout change here only affects in-flight rounds.
    pub open_positions: u32,
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
    /// Principal already deducted and waiting for `process_withdraw` to move
    /// the USDC. 0 when nothing is owed.
    pub pending_withdraw: u64,
    /// The epoch the pending amount was requested in. It pays out once
    /// `pool.current_epoch_id` is past it.
    pub pending_epoch: u64,
    /// When `request_withdraw` booked the pending amount. The second way a
    /// request matures, so a stalled operator who never calls `begin_epoch`
    /// cannot freeze a depositor's money.
    pub requested_at: i64,
    /// Σ principal × seconds within `epoch_id`. Mirrors `weight_acc` with
    /// Principal in place of Entries.
    pub principal_acc: u128,
    /// Final principal-seconds for `frozen_epoch`, set by
    /// [`crate::touch::touch`] alongside `frozen_weight`.
    pub frozen_principal_acc: u128,
    /// The epoch Base yield was last credited for. Guards `register` against
    /// crediting the same epoch twice, independent of `reg_epoch` (which a
    /// zero-weight registration never sets).
    pub yield_epoch: u64,
    /// The epoch `bought_amount` is counted against. `buy_tickets` resets
    /// `bought_amount` to 0 when this no longer matches the pool's current
    /// epoch.
    pub bought_epoch: u64,
    /// USDC spent in `buy_tickets` so far in `bought_epoch`, capped at
    /// `principal`.
    pub bought_amount: u64,
    /// The epoch `bonus_granted` is counted against. Separate from
    /// `bought_epoch` so an operator grant and a bought-tickets purchase
    /// don't share a cap.
    pub bonus_epoch: u64,
    /// Tickets an operator `grant_tickets` call has credited this Player so
    /// far in `bonus_epoch`, capped at `principal`. An admin grant does not
    /// count against it.
    pub bonus_granted: u64,
    /// Set to [`CURRENT_VERSION`] by `Player::init_if_fresh`. See
    /// `Pool::version`.
    pub version: u8,
    /// Take new fields from here. Their zero value must be the safe default,
    /// or bump `version` and migrate on first touch. See ADR 0013. Smaller
    /// than `Pool`'s and `Epoch`'s: Player rent is paid by the depositor.
    pub _reserved: [u8; 64],
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
        self.version = CURRENT_VERSION;
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

#[cfg(test)]
mod tests {
    use super::*;

    // Pins every account's on-chain size to a literal so a field added,
    // removed, reordered or resized has to update this test on purpose
    // (ticket ops-and-envs/01) instead of silently churning the layout.
    #[test]
    fn account_sizes_are_pinned_to_their_literal_byte_counts() {
        assert_eq!(Pool::INIT_SPACE, 653);
        assert_eq!(Epoch::INIT_SPACE, 223);
        assert_eq!(Player::INIT_SPACE, 307);
        assert_eq!(Round::INIT_SPACE, 383);
        assert_eq!(Position::INIT_SPACE, 81);
    }
}
