/// Hex tiles on a round's board, indexed 0..35.
pub const TILE_COUNT: u8 = 36;
pub const TILE_MASK: u64 = (1u64 << TILE_COUNT) - 1;

/// 100% in basis points. `Pool::house_cut_bps` is capped at this.
pub const BPS_DENOMINATOR: u16 = 10_000;

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
