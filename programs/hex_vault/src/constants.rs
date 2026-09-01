pub const USDC_DECIMALS: u8 = 6;
pub const TILE_COUNT: u8 = 36;
pub const TILE_MASK: u64 = (1u64 << TILE_COUNT) - 1;
pub const MAX_MERKLE_DEPTH: usize = 32;

pub const EPOCH_OPEN: u8 = 0;
pub const EPOCH_SNAPSHOT_COMMITTED: u8 = 1;
pub const EPOCH_RANDOMNESS_REQUESTED: u8 = 2;
pub const EPOCH_PRIZE_DRAWN: u8 = 3;
pub const EPOCH_PRIZE_CLAIMED: u8 = 4;
pub const EPOCH_PRIZE_EXPIRED: u8 = 5;

pub const ROUND_OPEN: u8 = 0;
pub const ROUND_RANDOMNESS_REQUESTED: u8 = 1;
pub const ROUND_SETTLED: u8 = 2;

pub const REQUEST_PENDING: u8 = 0;
pub const REQUEST_FULFILLED: u8 = 1;
pub const REQUEST_ROUND: u8 = 0;
pub const REQUEST_PRIZE: u8 = 1;
