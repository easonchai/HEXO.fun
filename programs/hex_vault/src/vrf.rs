//! ORAO VRF v2 integration.
//!
//! Settle instructions never trust a client-supplied sample: they read the
//! fulfilled randomness account bound to this exact request and check its
//! address against [`randomness_address`]. The `RandomnessV2` layout below is
//! pinned to ORAO's Anchor account (program `VRFzZo…`, source verified
//! 2026-09), so no dependency on ORAO's Anchor-0.30-era SDK is required.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::errors::HexVaultError;

pub const ORAO_VRF_PROGRAM_ID: Pubkey = pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");

/// ORAO request-account PDA seed prefix.
pub const ORAO_REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";

/// ORAO network-state PDA seed prefix.
pub const ORAO_NETWORK_STATE_SEED: &[u8] = b"orao-vrf-network-configuration";

/// Seed prefix for the stand-in randomness account `test_fulfill` writes.
pub const TEST_VRF_SEED: &[u8] = b"test-vrf";

fn sha256(bytes: &[u8]) -> [u8; 32] {
    hashv(&[bytes]).to_bytes()
}

/// PDA of ORAO's request account for one of our seeds. Fully determined by
/// (network_state, seed), so a settle instruction can prove the account it
/// reads is the one bound to this request.
pub fn orao_request_address(network_state: &Pubkey, seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[ORAO_REQUEST_SEED, network_state.as_ref(), seed.as_ref()],
        &ORAO_VRF_PROGRAM_ID,
    )
    .0
}

/// Address the settle path must be handed for `seed`.
///
/// Real builds: ORAO's request PDA. `test-vrf` builds: a PDA of this program
/// that [`crate::test_vrf::test_fulfill`] can write, so localnet tests need
/// no ORAO deployment. The two never coexist — the devnet build is compiled
/// without the feature.
pub fn randomness_address(network_state: &Pubkey, seed: &[u8; 32]) -> Pubkey {
    #[cfg(feature = "test-vrf")]
    {
        let _ = network_state;
        return Pubkey::find_program_address(&[TEST_VRF_SEED, seed.as_ref()], &crate::ID).0;
    }
    #[cfg(not(feature = "test-vrf"))]
    orao_request_address(network_state, seed)
}

/// Anchor discriminator of ORAO's `RandomnessV2` account.
pub fn randomness_discriminator() -> [u8; 8] {
    sha256(b"account:RandomnessV2")[..8]
        .try_into()
        .expect("fixed slice")
}

/// Byte length of a fulfilled `RandomnessV2` account:
/// `[8 discriminator][1 enum tag][32 client][32 seed][64 randomness]`.
pub const FULFILLED_LEN: usize = 8 + 1 + 32 + 32 + 64;

/// Extracts the 64-byte randomness from a fulfilled `RandomnessV2` account.
///
/// The tag is ORAO's `RequestAccount` borsh enum (`Pending = 0`,
/// `Fulfilled = 1`). Pending accounts are rejected: only a finalized draw may
/// settle a round or an epoch.
pub fn parse_fulfilled(data: &[u8]) -> Result<[u8; 64]> {
    if data.len() < FULFILLED_LEN {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    if data[..8] != randomness_discriminator()[..] {
        return Err(HexVaultError::InvalidRandomnessAccount.into());
    }
    if data[8] != 1 {
        return Err(HexVaultError::RandomnessNotFulfilled.into());
    }
    let mut randomness = [0u8; 64];
    randomness.copy_from_slice(&data[FULFILLED_LEN - 64..]);
    Ok(randomness)
}

/// Reads the randomness account for `seed`, proving it is the one bound to
/// this request and that it has been fulfilled.
pub fn read_fulfilled(
    account: &AccountInfo,
    network_state: &Pubkey,
    seed: &[u8; 32],
) -> Result<[u8; 64]> {
    require_keys_eq!(
        *account.key,
        randomness_address(network_state, seed),
        HexVaultError::InvalidRandomnessAccount
    );
    parse_fulfilled(&account.try_borrow_data()?)
}

/// True when the account exists, matches the request, and is fulfilled.
/// Used by the operator's fulfilled check, never as a substitute for
/// [`read_fulfilled`] in an instruction.
pub fn is_fulfilled(account: &AccountInfo, network_state: &Pubkey, seed: &[u8; 32]) -> bool {
    read_fulfilled(account, network_state, seed).is_ok()
}

/// Requests randomness for one subject (a round's board or an epoch's draw).
/// Both request paths (rounds.rs, epochs.rs) call this so the CPI is written
/// once.
///
/// `test-vrf` builds no-op: nothing needs to exist here, because
/// [`crate::test_vrf::test_fulfill`] fabricates the fulfilled account
/// directly instead of going through a real request/fulfill round trip.
#[cfg(feature = "test-vrf")]
pub fn request_randomness<'info>(
    _payer: &AccountInfo<'info>,
    _network_state: &AccountInfo<'info>,
    _randomness: &AccountInfo<'info>,
    _vrf_program: &AccountInfo<'info>,
    _system_program: &AccountInfo<'info>,
    _seed: [u8; 32],
) -> Result<()> {
    Ok(())
}

/// Real builds CPI ORAO's `request_v2` with `seed`, funded by `payer`. Left
/// as `todo!()`: ticket 03 owns verifying ORAO's exact account list and
/// instruction discriminator against the deployed program before wiring
/// this up for real.
#[cfg(not(feature = "test-vrf"))]
pub fn request_randomness<'info>(
    _payer: &AccountInfo<'info>,
    _network_state: &AccountInfo<'info>,
    _randomness: &AccountInfo<'info>,
    _vrf_program: &AccountInfo<'info>,
    _system_program: &AccountInfo<'info>,
    _seed: [u8; 32],
) -> Result<()> {
    // Verified against ORAO's own generated Anchor IDL and CPI example on
    // their GitHub master branch (orao-network/solana-vrf, fetched
    // 2026-09-05): `js/src/types/orao_vrf.json` (instruction `request_v2`)
    // and `rust/examples/cpi/programs/russian-roulette/src/lib.rs`.
    //
    //   discriminator: [38, 151, 209, 6, 195, 102, 28, 217]
    //   accounts, in order:
    //     payer          (signer, mut)
    //     network_state  (mut) - PDA [CONFIG_ACCOUNT_SEED], ORAO program
    //     treasury       (mut) - must equal network_state.config.treasury
    //                    (or its token-fee treasury); ORAO enforces this
    //                    itself, this program only forwards it
    //     request        (mut) - PDA [RANDOMNESS_ACCOUNT_SEED, seed], ORAO
    //                    program; created by ORAO's own `init` when it
    //                    processes this CPI, not by us
    //     system_program
    //   data: discriminator ++ seed (32 raw bytes, Borsh's encoding of a
    //   fixed-size array has no length prefix)
    //
    // This function's signature (fixed outside ticket 03's scope) has no
    // `treasury` parameter, so the CPI cannot be assembled with the accounts
    // it is given - `RequestRoundRandomness` would need a `treasury` field
    // and this function a `_treasury: &AccountInfo<'info>` parameter. Left
    // as `todo!()` rather than guessing an account list that would fail
    // silently on devnet; see the ticket 03 report for detail.
    todo!("ORAO request_v2 CPI - ticket 03: signature is missing the required `treasury` account, see comment above")
}

/// u64 sample from the first 8 bytes of the randomness (LE).
pub fn sample_u64(randomness: &[u8; 64]) -> u64 {
    u64::from_le_bytes(randomness[..8].try_into().expect("fixed slice"))
}

/// u128 sample from the first 16 bytes of the randomness (LE).
pub fn sample_u128(randomness: &[u8; 64]) -> u128 {
    u128::from_le_bytes(randomness[..16].try_into().expect("fixed slice"))
}

/// Unbiased mapping that can never strand a fulfilled draw: a tail sample
/// (rejected for modulo-bias safety) is re-derived by hashing the randomness
/// with a counter, instead of reverting a settle that has no retry path.
/// Deterministic and oracle-verifiable; the tail has probability
/// `range / 2^64`, so the counter practically never advances.
pub fn unbiased_u64(randomness: &[u8; 64], range: u64) -> Result<u64> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    let limit = u64::MAX - (u64::MAX % range);
    let mut counter: u8 = 0;
    loop {
        let sample = if counter == 0 {
            sample_u64(randomness)
        } else {
            u64::from_le_bytes(rederive(randomness, counter)[..8].try_into().expect("fixed"))
        };
        if sample < limit {
            return Ok(sample % range);
        }
        counter = counter
            .checked_add(1)
            .ok_or(HexVaultError::RandomnessRejection)?;
    }
}

/// The u128 twin of [`unbiased_u64`], for selecting a point in an epoch's
/// registered weight.
pub fn unbiased_u128(randomness: &[u8; 64], range: u128) -> Result<u128> {
    require!(range > 0, HexVaultError::RandomnessRejection);
    let limit = u128::MAX - (u128::MAX % range);
    let mut counter: u8 = 0;
    loop {
        let sample = if counter == 0 {
            sample_u128(randomness)
        } else {
            u128::from_le_bytes(rederive(randomness, counter)[..16].try_into().expect("fixed"))
        };
        if sample < limit {
            return Ok(sample % range);
        }
        counter = counter
            .checked_add(1)
            .ok_or(HexVaultError::RandomnessRejection)?;
    }
}

fn rederive(randomness: &[u8; 64], counter: u8) -> [u8; 32] {
    let mut buf = [0u8; 65];
    buf[..64].copy_from_slice(randomness);
    buf[64] = counter;
    sha256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fulfilled_account(randomness: [u8; 64]) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&randomness_discriminator());
        data.push(1); // RequestAccount::Fulfilled
        data.extend_from_slice(&[9u8; 32]); // client
        data.extend_from_slice(&[7u8; 32]); // seed
        data.extend_from_slice(&randomness);
        data
    }

    #[test]
    fn request_address_is_bound_to_seed_and_network() {
        let state = Pubkey::new_from_array([7u8; 32]);
        let a = orao_request_address(&state, &[1u8; 32]);
        assert_ne!(a, orao_request_address(&state, &[2u8; 32]));
        assert_ne!(a, orao_request_address(&Pubkey::new_unique(), &[1u8; 32]));
        assert_eq!(a, orao_request_address(&state, &[1u8; 32]));
    }

    #[test]
    fn parses_fulfilled_and_rejects_pending_or_foreign_accounts() {
        let data = fulfilled_account([4u8; 64]);
        assert_eq!(parse_fulfilled(&data).expect("fulfilled"), [4u8; 64]);

        let mut pending = data.clone();
        pending[8] = 0;
        assert!(parse_fulfilled(&pending)
            .unwrap_err()
            .to_string()
            .contains("not yet fulfilled"));

        let mut foreign = data.clone();
        foreign[0] ^= 0xff;
        assert!(parse_fulfilled(&foreign).is_err());

        assert!(parse_fulfilled(&data[..data.len() - 1]).is_err());
    }

    #[test]
    fn unbiased_mapping_survives_a_tail_sample() {
        // First 16 bytes all 0xff: a guaranteed tail rejection for both
        // widths. The naive mapping would revert forever, and a fulfilled
        // VRF account has no retry path.
        let mut tail = [0u8; 64];
        tail[..16].copy_from_slice(&[0xff; 16]);

        assert!(unbiased_u64(&tail, 36).expect("terminates") < 36);
        assert!(unbiased_u128(&tail, 1_000).expect("terminates") < 1_000);
        assert!(unbiased_u64(&tail, 0).is_err());
        assert!(unbiased_u128(&tail, 0).is_err());
    }

    #[test]
    fn tile_selection_is_deterministic_for_the_same_randomness() {
        let r = [42u8; 64];
        assert_eq!(unbiased_u64(&r, 36).unwrap(), unbiased_u64(&r, 36).unwrap());
    }
}
