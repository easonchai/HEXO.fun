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

/// Randomness seed for one subject. Deterministic in (domain, pool, id) so
/// the operator can derive the randomness account off-chain without reading
/// the Round or Epoch first.
pub fn vrf_seed(domain: &[u8], pool: &Pubkey, id: u64) -> [u8; 32] {
    hashv(&[domain, pool.as_ref(), &id.to_le_bytes()]).to_bytes()
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
        let base = vrf_seed(b"round", &pool, 7);
        assert_eq!(base, vrf_seed(b"round", &pool, 7), "deterministic");
        assert_ne!(base, vrf_seed(b"epoch", &pool, 7));
        assert_ne!(base, vrf_seed(b"round", &other, 7));
        assert_ne!(base, vrf_seed(b"round", &pool, 8));
    }
}
