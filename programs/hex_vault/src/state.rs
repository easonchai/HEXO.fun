use anchor_lang::prelude::*;

/// Program-global roles and mode. Holds no custody and no asset identity.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub snapshot_authority: Pubkey,
    pub mock_randomness_authority: Pubkey,
    /// ORAO VRF network-state account; zero disables `*_with_vrf` settle
    /// (mock-only deployments). Mock fulfillment additionally requires
    /// `production_mode == false`, so a VRF-configured production pool can
    /// never fall back to the operator-supplied path.
    pub vrf_randomness_state: Pubkey,
    pub production_mode: bool,
    pub bump: u8,
}

/// One isolated pool instance. The accepted asset, its token program, the
/// receipt mints, and all vault identities are set here exactly once, at
/// creation, and have no update path. Limits are equally immutable in v1
/// (a timelocked `set_pool_limits` is a documented future upgrade).
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u64,
    pub paused: bool,
    pub accepted_mint: Pubkey,
    pub accepted_token_program: Pubkey,
    pub accepted_decimals: u8,
    pub principal_mint: Pubkey,
    pub entry_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub prize_vault: Pubkey,
    pub jackpot_vault: Pubkey,
    pub min_deposit: u64,
    pub max_stake_per_tile: u64,
    pub max_round_bonus_entries: u64,
    pub min_epoch_seconds: i64,
    pub max_epoch_seconds: i64,
    pub round_close_buffer_seconds: i64,
    /// Set to the newest epoch when it is created; used to prove a supplied
    /// epoch account is the active one rather than a stale open epoch.
    pub latest_epoch_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub last_entry_epoch_id: u64,
    pub bump: u8,
}

/// One epoch's schedule is fully committed at creation and has no edit path.
/// Ordering is enforced at creation: starts_at < entry_cutoff_at <= ends_at
/// <= prize_snapshot_at <= claim_deadline, within the pool's duration bounds.
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub pool: Pubkey,
    pub id: u64,
    pub starts_at: i64,
    pub entry_cutoff_at: i64,
    pub ends_at: i64,
    pub prize_snapshot_at: i64,
    pub claim_deadline: i64,
    pub status: u8,
    pub prize_snapshot_root: [u8; 32],
    pub total_entry_weight: u64,
    pub prize_amount: u64,
    pub prize_target: u64,
    /// 0 = no jackpot this epoch; see JACKPOT_* states.
    pub jackpot_status: u8,
    pub jackpot_amount: u64,
    pub jackpot_target: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub pool: Pubkey,
    pub epoch: Pubkey,
    pub epoch_id: u64,
    pub id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub status: u8,
    pub winning_tile: u8,
    pub bonus_entries: u64,
    pub total_stake: u64,
    pub tile_stakes: [u64; 36],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub round: Pubkey,
    pub round_id: u64,
    pub tiles: u64,
    pub stake_per_tile: u64,
    pub reward_claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RandomnessRequest {
    pub pool: Pubkey,
    pub kind: u8,
    pub status: u8,
    pub subject: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    /// Final VRF seed: the requester's client seed mixed with the slot hash
    /// of the request slot, so it is unknowable before the request lands.
    pub seed: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub guardian: Pubkey,
    pub snapshot_authority: Pubkey,
    pub mock_randomness_authority: Pubkey,
    /// ORAO VRF network-state account, or zero to run mock-only.
    pub vrf_randomness_state: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreatePoolParams {
    pub pool_id: u64,
    pub min_deposit: u64,
    pub max_stake_per_tile: u64,
    pub max_round_bonus_entries: u64,
    pub min_epoch_seconds: i64,
    pub max_epoch_seconds: i64,
    pub round_close_buffer_seconds: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EpochTiming {
    pub id: u64,
    pub starts_at: i64,
    pub entry_cutoff_at: i64,
    pub ends_at: i64,
    pub prize_snapshot_at: i64,
    pub claim_deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MerkleProofNode {
    pub sibling_hash: [u8; 32],
    pub sibling_sum: u64,
    pub sibling_is_left: bool,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub pool_id: u64,
    pub accepted_mint: Pubkey,
}

#[event]
pub struct ProtocolPauseChanged {
    pub pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct DepositRecorded {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount: u64,
}

#[event]
pub struct WithdrawalRecorded {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EntriesRefreshed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub principal_entries: u64,
}

#[event]
pub struct PositionPurchased {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    pub tiles: u64,
    pub total_stake: u64,
}

#[event]
pub struct RoundRandomnessRequested {
    pub pool: Pubkey,
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
}

#[event]
pub struct RoundSettled {
    pub pool: Pubkey,
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    pub winning_tile: u8,
}

#[event]
pub struct RoundRewardClaimed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub round: Pubkey,
    pub reward: u64,
}

#[event]
pub struct PrizeFunded {
    pub pool: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct JackpotFunded {
    pub pool: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PrizeSnapshotCommitted {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub prize_amount: u64,
    pub total_entry_weight: u64,
    pub root: [u8; 32],
}

#[event]
pub struct JackpotCommitted {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub jackpot_amount: u64,
}

#[event]
pub struct PrizeRandomnessRequested {
    pub pool: Pubkey,
    pub epoch_id: u64,
}

#[event]
pub struct JackpotRandomnessRequested {
    pub pool: Pubkey,
    pub epoch_id: u64,
}

#[event]
pub struct PrizeDrawn {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub target: u64,
}

#[event]
pub struct JackpotDrawn {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub target: u64,
}

#[event]
pub struct PrizeClaimed {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct JackpotClaimed {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PrizeExpired {
    pub pool: Pubkey,
    pub epoch_id: u64,
}

#[event]
pub struct JackpotExpired {
    pub pool: Pubkey,
    pub epoch_id: u64,
}

#[event]
pub struct EpochCreated {
    pub pool: Pubkey,
    pub epoch_id: u64,
    pub starts_at: i64,
    pub entry_cutoff_at: i64,
    pub ends_at: i64,
    pub prize_snapshot_at: i64,
    pub claim_deadline: i64,
}
