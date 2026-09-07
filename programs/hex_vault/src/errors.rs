use anchor_lang::prelude::*;

#[error_code]
pub enum HexVaultError {
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,

    // Custody
    #[msg("the pool is paused")]
    PoolPaused,
    #[msg("deposit is below the pool minimum")]
    BelowMinimumDeposit,
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("principal is lower than the requested amount")]
    InsufficientPrincipal,
    #[msg("entries are lower than the requested amount")]
    InsufficientEntries,
    #[msg("token account has the wrong mint")]
    MintMismatch,
    #[msg("token account is not owned by the pool authority")]
    NotAuthorityOwned,
    #[msg("parameter is outside its allowed range")]
    InvalidParameter,
    #[msg("the House cannot hold Principal")]
    HouseCannotDeposit,

    // Rounds
    #[msg("a round is already open for this pool")]
    RoundAlreadyOpen,
    #[msg("round is not open")]
    RoundNotOpen,
    #[msg("round is closed to new positions")]
    RoundClosed,
    #[msg("round has not ended yet")]
    RoundNotEnded,
    #[msg("round randomness has not been requested")]
    RoundNotRequested,
    #[msg("round is not settled")]
    RoundNotSettled,
    #[msg("round would end after the current epoch")]
    RoundOutsideEpoch,
    #[msg("round length does not match the pool's round_seconds")]
    InvalidRoundLength,
    #[msg("tile selection must be a non-empty mask over tiles 0..35")]
    InvalidTileSelection,
    #[msg("stake per tile must be at least one entry")]
    InvalidStake,

    // Epochs
    #[msg("the current epoch has not ended yet")]
    EpochNotEnded,
    #[msg("epoch is not accepting registrations")]
    EpochNotRegistering,
    #[msg("epoch is not drawing")]
    EpochNotDrawing,
    #[msg("epoch has not been drawn")]
    EpochNotDrawn,
    #[msg("only the epoch immediately before the current one may be registered")]
    NotPreviousEpoch,
    #[msg("player is already registered for this epoch")]
    AlreadyRegistered,
    #[msg("player's frozen weight belongs to a different epoch")]
    FrozenEpochMismatch,
    #[msg("player is not registered for this epoch")]
    NotRegistered,
    #[msg("the drawn target is outside this player's registered interval")]
    NotTheWinner,
    #[msg("no weight was registered for this epoch")]
    NothingRegistered,

    // Randomness
    #[msg("randomness account does not match the request seed")]
    InvalidRandomnessAccount,
    #[msg("randomness is not yet fulfilled")]
    RandomnessNotFulfilled,
    #[msg("randomness sample fell in the rejected tail")]
    RandomnessRejection,
    #[msg("the randomness timeout has not elapsed")]
    VrfTimeoutNotElapsed,
}
