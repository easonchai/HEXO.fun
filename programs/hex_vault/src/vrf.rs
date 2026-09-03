//! ORAO VRF v2 integration, pull model.
//!
//! Settle instructions never trust a client-supplied sample: they read the
//! fulfilled ORAO randomness account that is bound to this exact request
//! (a PDA of ORAO's program derived from the seed stored at request time).
//! The account layout below is pinned to ORAO's `RandomnessV2` Anchor
//! account (program `VRFzZo…`, source verified 2026-09), so no crate
//! dependency on ORAO's Anchor-0.30-era SDK is required.

use anchor_lang::prelude::{pubkey, Pubkey, Result};
use anchor_lang::require;
use solana_sha256_hasher::hashv;

use crate::errors::HexVaultError;

pub const ORAO_VRF_PROGRAM_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

/// ORAO request-account PDA seed prefix.
pub const ORAO_REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";

/// ORAO network-state PDA seed prefix (its account address is stored in
/// [`crate::state::ProtocolConfig::vrf_randomness_state`]).
pub const ORAO_NETWORK_STATE_SEED: &[u8] = b"orao-vrf-network-configuration";

/// SlotHashes sysvar address (constrained on every request instruction).
pub const SLOTHASHES_SYSVAR_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

fn sha256(bytes: &[u8]) -> [u8; 32] {
    hashv(&[bytes]).to_bytes()
}

/// PDA of ORAO's request account for one of our stored seeds. Fully
/// determined by (network_state, seed), so a settle instruction can verify
/// the account it reads is the one bound to this request — nothing
/// submitter-chosen can slip in.
pub fn orao_request_address(network_state: &Pubkey, seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[ORAO_REQUEST_SEED, network_state.as_ref(), seed.as_ref()],
        &ORAO_VRF_PROGRAM_ID,
    )
    .0
}

/// Binds the requester's client seed to the slot hash of the slot the
/// request lands in, making the final seed unknowable before the request
/// transaction exists: neither pre-computation nor seed grinding survives.
pub fn mix_seed(client_seed: [u8; 32], slot_hash: [u8; 32], slot: u64) -> [u8; 32] {
    let mut buf = [0u8; 72];
    buf[..32].copy_from_slice(&client_seed);
    buf[32..64].copy_from_slice(&slot_hash);
    buf[64..].copy_from_slice(&slot.to_le_bytes());
    hashv(&[&buf]).to_bytes()
}

/// First (most recent) entry of the SlotHashes sysvar: `(slot, hash)`.
/// Layout: `u32` entry count, then newest-first `(u64 slot, [u8; 32] hash)`.
pub fn latest_slot_hash(data: &[u8]) -> Result<(u64, [u8; 32])> {
    if data.len() < 44 {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    let count = u32::from_le_bytes(data[0..4].try_into().expect("fixed slice"));
    require!(count > 0, HexVaultError::InvalidRandomnessAccount);
    let slot = u64::from_le_bytes(data[4..12].try_into().expect("fixed slice"));
    let mut hash_bytes = [0u8; 32];
    hash_bytes.copy_from_slice(&data[12..44]);
    Ok((slot, hash_bytes))
}

/// Extracts the 64-byte randomness from a fulfilled `RandomnessV2` account.
///
/// Layout: `[8B discriminator][1B enum tag][client 32B][seed 32B][randomness 64B]`,
/// where the tag is ORAO's `RequestAccount` borsh enum (`Pending = 0`,
/// `Fulfilled = 1`). Pending accounts are rejected: only finalized draws
/// may settle a round or epoch.
pub fn parse_fulfilled(data: &[u8]) -> Result<[u8; 64]> {
    const FULFILLED_LEN: usize = 8 + 1 + 32 + 32 + 64;
    if data.len() < FULFILLED_LEN {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    let disc = sha256(b"account:RandomnessV2");
    if data[..8] != disc[..8] {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    if data[8] != 1 {
        return Err(HexVaultError::RandomnessNotFulfilled.into());
    }
    let mut randomness = [0u8; 64];
    randomness.copy_from_slice(&data[FULFILLED_LEN - 64..]);
    Ok(randomness)
}

/// u64 sample from the first 8 bytes of the fulfilled randomness (LE).
pub fn sample_from(randomness: &[u8; 64]) -> u64 {
    u64::from_le_bytes(randomness[..8].try_into().expect("fixed slice"))
}

/// Unbiased mapping that can never strand a fulfilled VRF draw: a tail
/// sample (rejected for modulo-bias safety) is re-derived by hashing the
/// randomness with a counter, instead of reverting a settle that has no
/// retry path. Deterministic and oracle-verifiable; the tail has
/// probability `range / 2^64`, so the counter practically never advances.
/// Returns `(value, rederivations_used)`.
pub fn unbiased_from_randomness(randomness: &[u8; 64], range: u64) -> Result<(u64, u8)> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    let limit = u64::MAX - (u64::MAX % range);
    let mut counter: u8 = 0;
    loop {
        let sample: u64 = if counter == 0 {
            sample_from(randomness)
        } else {
            let mut buf = [0u8; 65];
            buf[..64].copy_from_slice(randomness);
            buf[64] = counter;
            u64::from_le_bytes(sha256(&buf)[..8].try_into().expect("fixed slice"))
        };
        if sample < limit {
            return Ok((sample % range, counter));
        }
        counter = counter
            .checked_add(1)
            .ok_or(HexVaultError::RandomnessRejection)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Anchor discriminator: sha256("account:RandomnessV2")[..8].
    fn expected_discriminator() -> [u8; 8] {
        sha256(b"account:RandomnessV2")[..8]
            .try_into()
            .expect("fixed slice")
    }

    #[test]
    fn request_address_is_bound_to_seed_and_network() {        let state = Pubkey::new_from_array([7u8; 32]);
        let a = orao_request_address(&state, &[1u8; 32]);
        let b = orao_request_address(&state, &[2u8; 32]);
        let c = orao_request_address(&Pubkey::new_from_array([9u8; 32]), &[1u8; 32]);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, orao_request_address(&state, &[1u8; 32]));
    }

    #[test]
    fn mixed_seed_depends_on_every_input() {
        let base = mix_seed([1u8; 32], [2u8; 32], 100);
        assert_ne!(base, mix_seed([3u8; 32], [2u8; 32], 100));
        assert_ne!(base, mix_seed([1u8; 32], [3u8; 32], 100));
        assert_ne!(base, mix_seed([1u8; 32], [2u8; 32], 101));
        assert_eq!(base, mix_seed([1u8; 32], [2u8; 32], 100));
    }

    #[test]
    fn latest_slot_hash_reads_the_newest_entry() {
        let mut data = Vec::new();
        data.extend_from_slice(&2u32.to_le_bytes());
        data.extend_from_slice(&100u64.to_le_bytes());
        data.extend_from_slice(&[1u8; 32]);
        data.extend_from_slice(&200u64.to_le_bytes());
        data.extend_from_slice(&[2u8; 32]);
        let (slot, hash_bytes) = latest_slot_hash(&data).expect("parses");
        assert_eq!(slot, 100);
        assert_eq!(hash_bytes, [1u8; 32]);
        assert!(latest_slot_hash(&[0, 0, 0, 0]).is_err());
    }

    #[test]
    fn parses_fulfilled_and_rejects_pending_or_foreign_accounts() {        let mut data = Vec::new();
        data.extend_from_slice(&expected_discriminator());
        data.push(1); // RequestAccount::Fulfilled
        data.extend_from_slice(&[9u8; 32]); // client
        data.extend_from_slice(&[7u8; 32]); // seed
        data.extend_from_slice(&[4u8; 64]); // randomness
        let parsed = parse_fulfilled(&data).expect("fulfilled parses");
        assert_eq!(parsed, [4u8; 64]);
        assert_eq!(sample_from(&parsed), u64::from_le_bytes([4u8; 8]));

        // Pending (tag 0): must not settle.
        let mut pending = data.clone();
        pending[8] = 0;
        assert!(parse_fulfilled(&pending)
            .unwrap_err()
            .to_string()
            .contains("not yet fulfilled"));

        // Wrong discriminator (not ORAO's account layout).
        let mut foreign = data.clone();
        foreign[0] ^= 0xff;
        assert!(parse_fulfilled(&foreign).is_err());

        // Truncated.
        assert!(parse_fulfilled(&data[..data.len() - 1]).is_err());
    }

    #[test]
    fn unbiased_mapping_survives_tail_samples() {
        // First 8 bytes = u64::MAX: a guaranteed tail rejection. The naive
        // mapping would revert forever (no retry path for a fulfilled VRF
        // account); re-derivation must terminate and stay in range.
        let mut tail = [0u8; 64];
        tail[..8].copy_from_slice(&u64::MAX.to_le_bytes());
        let (value, retries) = unbiased_from_randomness(&tail, 36).expect("terminates");
        assert!(value < 36 && retries >= 1);

        // Zero range is refused outright.
        assert!(unbiased_from_randomness(&tail, 0).is_err());
    }
}
