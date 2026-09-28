use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use crate::constants::{TILE_COUNT, TILE_MASK};
use crate::errors::HexVaultError;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Number of tiles a position mask covers. Rejects an empty mask and any bit
/// above tile 35.
pub fn tile_count(mask: u64) -> Result<u64> {
    require!(
        mask != 0 && mask & !TILE_MASK == 0,
        HexVaultError::InvalidTileSelection
    );
    Ok(u64::from(mask.count_ones()))
}

pub fn tile_is_covered(mask: u64, tile: u8) -> bool {
    tile < TILE_COUNT && (mask & (1u64 << tile)) != 0
}

/// Randomness seed for one subject. Deterministic in (domain, pool, id,
/// nonce): the nonce is a 32-byte value the Operator supplies fresh on every
/// randomness request, unpredictable ahead of time, so nobody can derive the
/// randomness account this request will use before the request itself lands
/// (beta-launch-fixes ticket 02). The operator can still derive the account
/// off-chain once it has picked its own nonce, without reading the Round or
/// Epoch first.
pub fn vrf_seed(domain: &[u8], pool: &Pubkey, id: u64, nonce: &[u8; 32]) -> [u8; 32] {
    hashv(&[domain, pool.as_ref(), &id.to_le_bytes(), nonce]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_count_rejects_empty_and_out_of_range_masks() {
        assert_eq!(tile_count(0b1011).expect("valid mask"), 3);
        assert_eq!(tile_count(TILE_MASK).expect("full board"), 36);
        assert!(tile_count(0).is_err());
        assert!(tile_count(1u64 << 36).is_err(), "tile 36 does not exist");
    }

    #[test]
    fn coverage_follows_the_mask() {
        let mask = (1u64 << 3) | (1u64 << 35);
        assert!(tile_is_covered(mask, 3));
        assert!(tile_is_covered(mask, 35));
        assert!(!tile_is_covered(mask, 4));
        assert!(!tile_is_covered(mask, 36));
    }

    #[test]
    fn seeds_separate_domains_pools_and_ids() {
        let pool = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let nonce = [1u8; 32];
        let base = vrf_seed(b"round", &pool, 7, &nonce);
        assert_eq!(base, vrf_seed(b"round", &pool, 7, &nonce), "deterministic");
        assert_ne!(base, vrf_seed(b"epoch", &pool, 7, &nonce));
        assert_ne!(base, vrf_seed(b"round", &other, 7, &nonce));
        assert_ne!(base, vrf_seed(b"round", &pool, 8, &nonce));
    }

    #[test]
    fn same_nonce_reproduces_the_same_seed_and_a_different_nonce_differs() {
        let pool = Pubkey::new_unique();
        let nonce_a = [1u8; 32];
        let nonce_b = [2u8; 32];
        assert_eq!(
            vrf_seed(b"round", &pool, 7, &nonce_a),
            vrf_seed(b"round", &pool, 7, &nonce_a),
            "same nonce, same seed"
        );
        assert_ne!(
            vrf_seed(b"round", &pool, 7, &nonce_a),
            vrf_seed(b"round", &pool, 7, &nonce_b),
            "different nonce, different seed"
        );
    }
}
