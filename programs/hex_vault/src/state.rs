use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub snapshot_authority: Pubkey,
    pub mock_randomness_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_token_program: Pubkey,
    pub receipt_token_program: Pubkey,
    pub principal_mint: Pubkey,
    pub entry_mint: Pubkey,
    pub principal_vault: Pubkey,
    pub prize_vault: Pubkey,
    pub current_epoch_id: u64,
    pub min_deposit: u64,
    pub max_stake_per_tile: u64,
    pub round_close_buffer_seconds: i64,
    pub paused: bool,
    pub production_mode: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub owner: Pubkey,
    pub last_entry_epoch_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub id: u64,
    pub starts_at: i64,
    pub ends_at: i64,
    pub prize_snapshot_at: i64,
    pub claim_deadline: i64,
    pub status: u8,
    pub prize_snapshot_root: [u8; 32],
    pub total_entry_weight: u64,
    pub prize_amount: u64,
    pub prize_target: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
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
    pub owner: Pubkey,
    pub round: Pubkey,
    pub tiles: u64,
    pub stake_per_tile: u64,
    pub reward_claimed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RandomnessRequest {
    pub kind: u8,
    pub status: u8,
    pub subject: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub guardian: Pubkey,
    pub snapshot_authority: Pubkey,
    pub mock_randomness_authority: Pubkey,
    pub min_deposit: u64,
    pub max_stake_per_tile: u64,
    pub round_close_buffer_seconds: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EpochTiming {
    pub id: u64,
    pub starts_at: i64,
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
pub struct DepositRecorded {
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub amount: u64,
}

#[event]
pub struct WithdrawalRecorded {
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EntriesRefreshed {
    pub owner: Pubkey,
    pub epoch_id: u64,
    pub principal_entries: u64,
}

#[event]
pub struct PositionPurchased {
    pub owner: Pubkey,
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    pub tiles: u64,
    pub total_stake: u64,
}

#[event]
pub struct RoundRandomnessRequested {
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
}

#[event]
pub struct RoundSettled {
    pub round: Pubkey,
    pub epoch_id: u64,
    pub round_id: u64,
    pub winning_tile: u8,
}

#[event]
pub struct RoundRewardClaimed {
    pub owner: Pubkey,
    pub round: Pubkey,
    pub reward: u64,
}

#[event]
pub struct PrizeFunded {
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct PrizeSnapshotCommitted {
    pub epoch_id: u64,
    pub prize_amount: u64,
    pub total_entry_weight: u64,
    pub root: [u8; 32],
}

#[event]
pub struct PrizeRandomnessRequested {
    pub epoch_id: u64,
}

#[event]
pub struct PrizeDrawn {
    pub epoch_id: u64,
    pub target: u64,
}

#[event]
pub struct PrizeClaimed {
    pub epoch_id: u64,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProtocolPauseChanged {
    pub paused: bool,
}
