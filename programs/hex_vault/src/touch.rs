//! The touch rule: lazy Entries reset and Weight accrual (spec §2.2).
//!
//! Every instruction that reads or changes a Player's Entries calls
//! [`touch`] first, before it applies its own change. Nothing sweeps players
//! at an epoch boundary; each player pays for their own reset the next time
//! they act.

use anchor_lang::prelude::*;

use crate::errors::HexVaultError;
use crate::state::{Player, Pool};

/// Seconds between two instants, clamped at zero. A negative span means the
/// clock moved backwards relative to a stored timestamp; crediting it as
/// negative weight would be worse than crediting nothing.
fn elapsed(from: i64, to: i64) -> u128 {
    u128::from(u64::try_from(to.saturating_sub(from)).unwrap_or(0))
}

fn weight_of(entries: u64, seconds: u128) -> Result<u128> {
    u128::from(entries)
        .checked_mul(seconds)
        .ok_or_else(|| HexVaultError::ArithmeticOverflow.into())
}

/// Brings `player` up to `now`.
///
/// Crossing an epoch boundary freezes the weight the player earned in the
/// epoch that just ended, resets Entries to Principal, and starts the new
/// epoch's accumulator. Within an epoch it just accrues.
///
/// The freeze reads `principal` and `entries` *before* the calling
/// instruction changes them, which is what closes the "deposit right after
/// the epoch ends to inflate last epoch's weight" hole.
pub fn touch(player: &mut Player, pool: &Pool, now: i64) -> Result<()> {
    if player.epoch_id >= pool.current_epoch_id {
        // Clamp accrual at the current epoch's `ends_at`: a late
        // `begin_epoch` must never let the same seconds count towards two
        // epochs (audit-fixes/01). `last_update` still advances to the real
        // `now` so a later call accrues nothing further (`elapsed` clamps a
        // negative span at zero) instead of re-adding the same tail.
        //
        // Before the first epoch (`current_epoch_id == 0`) there is no
        // `ends_at` to speak of yet -- `current_epoch_ends_at` is still its
        // zero placeholder -- so nothing is clamped.
        let accrue_until = if pool.current_epoch_id == 0 {
            now
        } else {
            now.min(pool.current_epoch_ends_at)
        };
        player.weight_acc = player
            .weight_acc
            .checked_add(weight_of(
                player.entries,
                elapsed(player.last_update, accrue_until),
            )?)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        player.last_update = now;
        return Ok(());
    }

    let previous_epoch_id = pool.current_epoch_id - 1;
    // The end `begin_epoch` actually gave that epoch. Usually
    // `current_epoch_start` too, but a `begin_epoch` that skipped a gap
    // leaves one nobody accrues in.
    let previous_ends_at = pool.previous_epoch_ends_at;

    player.frozen_weight = if player.epoch_id == previous_epoch_id {
        // Acted during the previous epoch: finish its accumulator at the
        // instant the epoch ended.
        player
            .weight_acc
            .checked_add(weight_of(
                player.entries,
                elapsed(player.last_update, previous_ends_at),
            )?)
            .ok_or(HexVaultError::ArithmeticOverflow)?
    } else {
        // Idle through the whole previous epoch, so Entries equalled
        // Principal for every second of it.
        weight_of(
            player.principal,
            elapsed(pool.previous_epoch_start, previous_ends_at),
        )?
    };
    player.frozen_epoch = previous_epoch_id;

    player.entries = player.principal;
    // Same clamp as the same-epoch branch above, against the *new* current
    // epoch's `ends_at`: a late `begin_epoch` must not let this
    // initialisation credit more than the new epoch's own length either.
    let new_ends_at = pool.current_epoch_ends_at;
    player.weight_acc = weight_of(
        player.principal,
        elapsed(pool.current_epoch_start, now.min(new_ends_at)),
    )?;
    player.last_update = now;
    player.epoch_id = pool.current_epoch_id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    /// A pool in epoch `id`, whose current epoch started at `start` and whose
    /// previous one ran for a full day before that.
    fn pool_at(id: u64, start: i64) -> Pool {
        Pool {
            pool_id: 1,
            authority: Pubkey::default(),
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
        }
    }

    #[test]
    fn accrues_within_the_current_epoch() {
        let pool = pool_at(3, 1_000);
        let mut p = player(100, 100, 3, 1_000);

        touch(&mut p, &pool, 1_060).expect("touch");
        assert_eq!(p.weight_acc, 100 * 60);
        assert_eq!(p.last_update, 1_060);

        // Accrual is incremental, not recomputed from the epoch start.
        touch(&mut p, &pool, 1_100).expect("touch");
        assert_eq!(p.weight_acc, 100 * 100);
        assert_eq!(p.epoch_id, 3);
        assert_eq!(p.frozen_weight, 0, "no boundary crossed, nothing frozen");
    }

    #[test]
    fn a_late_touch_in_the_current_epoch_clamps_accrual_at_ends_at() {
        // Epoch 3 started at 1_000 and, per epoch_seconds, ends at
        // 1_000 + DAY. The operator's begin_epoch is late: `now` is 500s past
        // that, but the pool is still on epoch 3, so this is the same-epoch
        // branch, not a rollover. The clamp keeps those 500s from being
        // credited here and then credited again once the epoch does roll.
        let pool = pool_at(3, 1_000);
        let mut p = player(100, 100, 3, 1_000);

        touch(&mut p, &pool, 1_000 + DAY + 500).expect("touch");

        assert_eq!(p.weight_acc, 100 * DAY as u128, "accrual stops at ends_at");
        assert_eq!(p.last_update, 1_000 + DAY + 500, "the clock itself still advances");
        assert_eq!(p.epoch_id, 3, "pool hasn't rolled over yet");

        // A further late touch adds nothing more: `elapsed` from a
        // last_update already past ends_at clamps at zero.
        touch(&mut p, &pool, 1_000 + DAY + 900).expect("touch");
        assert_eq!(p.weight_acc, 100 * DAY as u128);
    }

    #[test]
    fn freezes_the_previous_epoch_for_an_active_player() {
        // Epoch 3 ran [1_000, 1_000 + DAY). The player last acted 60 s in
        // holding 300 Entries after a game win, with 100 × 60 already
        // accumulated.
        let pool = pool_at(4, 1_000 + DAY);
        let mut p = player(100, 300, 3, 1_060);
        p.weight_acc = 100 * 60;

        touch(&mut p, &pool, 1_000 + DAY + 10).expect("touch");

        assert_eq!(p.frozen_weight, 100 * 60 + 300 * (DAY as u128 - 60));
        assert_eq!(p.frozen_epoch, 3);
        assert_eq!(p.entries, 100, "entries reset to principal");
        assert_eq!(p.weight_acc, 100 * 10, "new epoch accrues from its start");
        assert_eq!(p.epoch_id, 4);
    }

    #[test]
    fn a_late_rollover_touch_clamps_the_new_epochs_accrual_at_its_own_ends_at() {
        // Epoch 4 starts where epoch 3 ended (1_000 + DAY) and, per
        // epoch_seconds, itself ends a day after that. The player is touched
        // two full epoch-lengths late (begin_epoch for epoch 5 never ran),
        // so weight_acc's initialisation must not credit more than epoch 4's
        // own length.
        let pool = pool_at(4, 1_000 + DAY);
        let mut p = player(250, 250, 3, 1_000);

        touch(&mut p, &pool, 1_000 + 3 * DAY).expect("touch");

        assert_eq!(p.epoch_id, 4);
        assert_eq!(
            p.weight_acc,
            250 * DAY as u128,
            "credited at most the new epoch's own length"
        );
    }

    #[test]
    fn a_gap_between_epochs_counts_for_nobody() {
        // Epoch 3 ran [1_000, 1_000 + DAY). The operator was down, so
        // begin_epoch started epoch 4 at `now` = 1_000 + 3 * DAY instead of
        // chaining. Both the active and the idle player freeze exactly one
        // epoch's worth of weight, and neither gets the two-day gap.
        let mut pool = pool_at(4, 1_000 + 3 * DAY);
        pool.previous_epoch_start = 1_000;
        pool.previous_epoch_ends_at = 1_000 + DAY;

        // Touched once in the gap (same-epoch branch, clamped), then rolled.
        let mut active = player(100, 100, 3, 1_000);
        touch(&mut active, &pool_at(3, 1_000), 1_000 + 2 * DAY).expect("touch");
        touch(&mut active, &pool, 1_000 + 3 * DAY + 10).expect("touch");
        assert_eq!(active.frozen_weight, 100 * DAY as u128);
        assert_eq!(active.weight_acc, 100 * 10);

        let mut idle = player(250, 250, 1, 0);
        touch(&mut idle, &pool, 1_000 + 3 * DAY).expect("touch");
        assert_eq!(idle.frozen_weight, 250 * DAY as u128);
        assert_eq!(idle.frozen_epoch, 3);
    }

    #[test]
    fn idle_through_the_previous_epoch_freezes_principal_times_length() {
        // Last acted in epoch 1; the pool is now in epoch 4. Only the
        // immediately previous epoch (3) can still be registered, and the
        // player held Entries == Principal for all of it.
        let pool = pool_at(4, 1_000 + DAY);
        let mut p = player(250, 250, 1, 0);
        p.weight_acc = 999_999; // stale, must be discarded

        touch(&mut p, &pool, 1_000 + DAY).expect("touch");

        assert_eq!(p.frozen_weight, 250 * DAY as u128);
        assert_eq!(p.frozen_epoch, 3);
        assert_eq!(p.weight_acc, 0);
    }

    #[test]
    fn first_touch_of_a_fresh_player_credits_nothing() {
        let pool = pool_at(2, 5_000);
        let mut p = player(0, 0, 0, 0);
        p.owner = Pubkey::default(); // what `init_if_needed` actually leaves behind
        p.init_if_fresh(Pubkey::new_unique(), &pool, 5_500, 254);
        assert_eq!(p.last_update, 5_500, "init seeds the clock");
        assert_eq!(p.epoch_id, 2);

        touch(&mut p, &pool, 5_600).expect("touch");
        assert_eq!(p.weight_acc, 0);
        assert_eq!(p.frozen_weight, 0);
    }

    #[test]
    fn a_deposit_after_the_boundary_cannot_inflate_the_frozen_weight() {
        // The hole this rule closes: touch runs first, so the freeze sees
        // last epoch's principal, and the deposit lands in the new epoch.
        let pool = pool_at(4, 1_000 + DAY);
        let mut p = player(10, 10, 3, 1_000);

        touch(&mut p, &pool, 1_000 + DAY).expect("touch");
        let frozen_before_deposit = p.frozen_weight;

        p.principal += 1_000_000;
        p.entries += 1_000_000;

        assert_eq!(frozen_before_deposit, 10 * DAY as u128);
        assert_eq!(p.frozen_weight, frozen_before_deposit);
    }

    #[test]
    fn the_house_resets_to_zero_entries() {
        // The House holds no principal, so forfeited pots it collected in
        // one epoch do not survive into the next.
        let pool = pool_at(4, 1_000 + DAY);
        let mut p = player(0, 5_000, 3, 1_000);
        p.is_house = true;

        touch(&mut p, &pool, 1_000 + DAY).expect("touch");

        assert_eq!(p.entries, 0);
        assert_eq!(p.frozen_weight, 5_000 * DAY as u128);
    }

    #[test]
    fn changing_epoch_seconds_after_the_boundary_leaves_the_frozen_weight_alone() {
        // Epoch 3 ran [1_000, 1_000 + DAY) and epoch 4 opened where it ended.
        // The authority then switched the pool to hourly, before this player
        // was touched. The freeze must use the day epoch 3 actually ran, not
        // the new parameter.
        let mut pool = pool_at(4, 1_000 + DAY);
        pool.epoch_seconds = 3_600;
        let mut p = player(100, 100, 3, 1_000);

        touch(&mut p, &pool, 1_000 + DAY + 10).expect("touch");

        assert_eq!(p.frozen_weight, 100 * DAY as u128);
        assert_eq!(p.frozen_epoch, 3);
    }

    #[test]
    fn a_clock_that_moves_backwards_credits_nothing() {
        let pool = pool_at(3, 1_000);
        let mut p = player(100, 100, 3, 2_000);

        touch(&mut p, &pool, 1_500).expect("touch");

        assert_eq!(p.weight_acc, 0);
        assert_eq!(p.last_update, 1_500);
    }
}
