//! Every event the indexer decodes (spec §2.6). Renaming one breaks the
//! backend's event coder and the frontend feed.

use anchor_lang::prelude::*;

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub pool_id: u64,
    pub authority: Pubkey,
    pub accepted_mint: Pubkey,
}

#[event]
pub struct ParamsSet {
    pub pool: Pubkey,
    pub epoch_seconds: i64,
    pub epoch_anchor: i64,
    pub round_seconds: i64,
    pub close_buffer: i64,
    pub vrf_timeout: i64,
    pub min_deposit: u64,
}

#[event]
pub struct Paused {
    pub pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub entries: u64,
}

#[event]
pub struct Withdrawn {
    pub owner: Pubkey,
    pub amount: u64,
    pub principal: u64,
    pub entries: u64,
}

#[event]
pub struct RoundOpened {
    pub round_id: u64,
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    /// Entries carried in from a voided round.
    pub carry_in: u64,
}

#[event]
pub struct PositionBought {
    pub round_id: u64,
    pub owner: Pubkey,
    pub tiles: u64,
    pub stake_per_tile: u64,
    pub total: u64,
}

#[event]
pub struct RoundSettled {
    pub round_id: u64,
    pub winning_tile: u8,
    pub pot: u64,
    /// True when nobody covered the winning tile and the pot went to the House.
    pub forfeited: bool,
}

#[event]
pub struct RoundVoided {
    pub round_id: u64,
    pub carry_pot: u64,
}

#[event]
pub struct PositionSettled {
    pub round_id: u64,
    pub owner: Pubkey,
    pub reward: u64,
}

#[event]
pub struct EpochBegan {
    pub epoch_id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
}

#[event]
pub struct Registered {
    pub epoch_id: u64,
    pub owner: Pubkey,
    pub weight: u128,
    pub reg_start: u128,
    pub reg_end: u128,
}

#[event]
pub struct JackpotFunded {
    pub source: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochDrawn {
    pub epoch_id: u64,
    pub target: u128,
    pub registered_weight: u128,
}

#[event]
pub struct JackpotPaid {
    pub epoch_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
    pub is_house: bool,
}

#[event]
pub struct EpochRolledOver {
    pub epoch_id: u64,
    pub jackpot_amount: u64,
}
