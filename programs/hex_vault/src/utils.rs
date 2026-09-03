use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use crate::{
    constants::{EPOCH_OPEN, MAX_MERKLE_DEPTH, TILE_COUNT, TILE_MASK},
    errors::HexVaultError,
    state::{Epoch, MerkleProofNode, Pool},
};

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Mixes the requester's client seed with the newest slot hash so the final
/// VRF seed is unknowable before the request transaction exists (kills both
/// pre-computation and seed grinding).
pub fn mix_client_seed(
    recent_slothaves: &anchor_lang::prelude::AccountInfo,
    client_seed: [u8; 32],
) -> Result<[u8; 32]> {
    let (slot, slot_hash) = crate::vrf::latest_slot_hash(&recent_slothaves.try_borrow_data()?)?;
    Ok(crate::vrf::mix_seed(client_seed, slot_hash, slot))
}

/// At most one epoch per pool can be open (an epoch must resolve before the
/// next is created); this also proves the supplied epoch is the newest via
/// `latest_epoch_id`.
pub fn require_active_open_epoch(pool: &Pool, epoch: &Epoch) -> Result<()> {
    require!(
        epoch.id == pool.latest_epoch_id,
        HexVaultError::InactiveEpoch
    );
    require!(epoch.status == EPOCH_OPEN, HexVaultError::EpochNotOpen);
    Ok(())
}

pub fn validate_epoch_timing(
    timing: &crate::state::EpochTiming,
    pool: &crate::state::Pool,
) -> Result<()> {
    require!(
        timing.starts_at < timing.entry_cutoff_at,
        HexVaultError::InvalidTimeWindow
    );
    require!(
        timing.entry_cutoff_at <= timing.ends_at,
        HexVaultError::InvalidTimeWindow
    );
    require!(
        timing.prize_snapshot_at >= timing.ends_at
            && timing.prize_snapshot_at <= timing.claim_deadline,
        HexVaultError::InvalidTimeWindow
    );
    let duration = timing
        .ends_at
        .checked_sub(timing.starts_at)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(
        duration >= pool.min_epoch_seconds && duration <= pool.max_epoch_seconds,
        HexVaultError::InvalidTimeWindow
    );
    Ok(())
}

pub fn tile_count(mask: u64) -> Result<u32> {
    require!(
        mask != 0 && mask & !TILE_MASK == 0,
        HexVaultError::InvalidTileSelection
    );
    Ok(mask.count_ones())
}

pub fn unbiased_u64(sample: u64, range: u64) -> Result<u64> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    // The accepted interval [0, limit) has a cardinality divisible by range.
    // A callback sample in the small tail must trigger a new VRF request.
    let limit = u64::MAX - (u64::MAX % range);
    require!(sample < limit, HexVaultError::RandomnessRejection);
    Ok(sample % range)
}

pub fn unbiased_index(sample: u64, range: u8) -> Result<u8> {
    Ok(u8::try_from(unbiased_u64(sample, u64::from(range))?)
        .map_err(|_| HexVaultError::RandomnessRejection)?)
}

pub fn prize_leaf_hash(owner: &Pubkey, weight: u64) -> [u8; 32] {
    let weight_bytes = weight.to_le_bytes();
    hashv(&[
        b"hexvault:prize-leaf:v1".as_ref(),
        owner.as_ref(),
        weight_bytes.as_ref(),
    ])
    .to_bytes()
}

pub fn prize_node_hash(
    left_hash: &[u8; 32],
    left_sum: u64,
    right_hash: &[u8; 32],
    right_sum: u64,
) -> [u8; 32] {
    let left_sum_bytes = left_sum.to_le_bytes();
    let right_sum_bytes = right_sum.to_le_bytes();
    hashv(&[
        b"hexvault:prize-node:v1".as_ref(),
        left_hash.as_ref(),
        left_sum_bytes.as_ref(),
        right_hash.as_ref(),
        right_sum_bytes.as_ref(),
    ])
    .to_bytes()
}

pub fn verify_prize_proof(
    root: [u8; 32],
    expected_total: u64,
    owner: &Pubkey,
    weight: u64,
    proof: &[MerkleProofNode],
) -> Result<u64> {
    require!(
        weight > 0 && proof.len() <= MAX_MERKLE_DEPTH,
        HexVaultError::InvalidMerkleProof
    );

    let mut hash = prize_leaf_hash(owner, weight);
    let mut sum = weight;
    let mut prefix = 0u64;

    for node in proof {
        let combined_sum = node
            .sibling_sum
            .checked_add(sum)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        if node.sibling_is_left {
            prefix = prefix
                .checked_add(node.sibling_sum)
                .ok_or(HexVaultError::ArithmeticOverflow)?;
            hash = prize_node_hash(&node.sibling_hash, node.sibling_sum, &hash, sum);
        } else {
            hash = prize_node_hash(&hash, sum, &node.sibling_hash, node.sibling_sum);
        }
        sum = combined_sum;
    }

    require!(
        sum == expected_total && hash == root,
        HexVaultError::InvalidMerkleProof
    );
    Ok(prefix)
}

pub fn assert_winning_interval(prefix: u64, weight: u64, target: u64) -> Result<()> {
    let end = prefix
        .checked_add(weight)
        .ok_or(HexVaultError::ArithmeticOverflow)?;
    require!(
        target >= prefix && target < end,
        HexVaultError::NonWinningPrizeProof
    );
    Ok(())
}

pub fn tile_is_covered(mask: u64, tile: u8) -> bool {
    tile < TILE_COUNT && (mask & (1u64 << tile)) != 0
}
