/// Hex tiles on a round's board, indexed 0..35.
pub const TILE_COUNT: u8 = 36;
pub const TILE_MASK: u64 = (1u64 << TILE_COUNT) - 1;

/// 100% in basis points. `Pool::house_cut_bps` and `Pool::base_rate_bps` are
/// capped at this.
pub const BPS_DENOMINATOR: u16 = 10_000;

/// Written to `version` on a freshly created `Pool`, `Epoch` or `Player`.
/// There is no migration code yet, since nothing has shipped an older
/// version; see ADR 0013.
pub const CURRENT_VERSION: u8 = 1;

/// Denominator for `base_rate_bps`, an APR: seconds in a 365-day year.
pub const SECONDS_PER_YEAR: u128 = 31_536_000;

/// Floors for the two timeouts that gate the permissionless `void_round` and
/// `rollover_epoch` (production-hardening 14, Finding 5). Below these, a
/// merely slow ORAO fulfilment or an honest late Payout could be voided or
/// rolled over by any stranger the second the timeout passes. Localnet tests
/// run epochs of a few seconds, so `test-vrf` builds keep the floor at 1;
/// `lib.rs` refuses that feature together with `staging` or `mainnet`.
#[cfg(not(feature = "test-vrf"))]
pub const MIN_VRF_TIMEOUT: i64 = 60;
#[cfg(feature = "test-vrf")]
pub const MIN_VRF_TIMEOUT: i64 = 1;
#[cfg(not(feature = "test-vrf"))]
pub const MIN_PAYOUT_TIMEOUT: i64 = 600;
#[cfg(feature = "test-vrf")]
pub const MIN_PAYOUT_TIMEOUT: i64 = 1;

pub const SEED_POOL: &[u8] = b"pool";
pub const SEED_PRINCIPAL: &[u8] = b"principal";
pub const SEED_JACKPOT: &[u8] = b"jackpot";
pub const SEED_EPOCH: &[u8] = b"epoch";
pub const SEED_ROUND: &[u8] = b"round";
pub const SEED_PLAYER: &[u8] = b"player";
pub const SEED_POSITION: &[u8] = b"position";

/// `Epoch::status`. An epoch is Open while it is the current one, then walks
/// Registering → Drawing → Drawn → Paid, or short-circuits to RolledOver.
pub mod epoch_status {
    pub const OPEN: u8 = 0;
    pub const REGISTERING: u8 = 1;
    pub const DRAWING: u8 = 2;
    pub const DRAWN: u8 = 3;
    pub const PAID: u8 = 4;
    pub const ROLLED_OVER: u8 = 5;
}

/// `Round::status`. Open → Requested → Settled or Forfeited, or Voided when
/// the randomness never arrives.
pub mod round_status {
    pub const OPEN: u8 = 0;
    pub const REQUESTED: u8 = 1;
    pub const SETTLED: u8 = 2;
    pub const FORFEITED: u8 = 3;
    pub const VOIDED: u8 = 4;
}
