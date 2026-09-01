use anchor_lang::prelude::*;

#[error_code]
pub enum HexVaultError {
    #[msg("protocol is paused")]
    ProtocolPaused,
    #[msg("only the configured protocol authority may perform this action")]
    UnauthorizedAuthority,
    #[msg("only the configured guardian may perform this action")]
    UnauthorizedGuardian,
    #[msg("only the configured snapshot authority may perform this action")]
    UnauthorizedSnapshotAuthority,
    #[msg("only the configured mock randomness authority may perform this action")]
    UnauthorizedMockRandomnessAuthority,
    #[msg("mock randomness is disabled in production mode")]
    MockRandomnessDisabled,
    #[msg("the supplied epoch is not the active epoch")]
    InactiveEpoch,
    #[msg("epoch is not open")]
    EpochNotOpen,
    #[msg("epoch state does not allow this action")]
    InvalidEpochState,
    #[msg("round state does not allow this action")]
    InvalidRoundState,
    #[msg("randomness request state does not allow this action")]
    InvalidRandomnessRequest,
    #[msg("randomness request is not bound to this subject")]
    RandomnessSubjectMismatch,
    #[msg("randomness sample must be retried to avoid modulo bias")]
    RandomnessRejection,
    #[msg("time window is invalid")]
    InvalidTimeWindow,
    #[msg("round is not accepting positions")]
    RoundClosed,
    #[msg("position tiles are invalid")]
    InvalidTileSelection,
    #[msg("stake amount is invalid")]
    InvalidStakeAmount,
    #[msg("entry balance is insufficient")]
    InsufficientEntries,
    #[msg("principal and entry balances must both cover a withdrawal")]
    InsufficientMatchedBalance,
    #[msg("amount must be non-zero")]
    ZeroAmount,
    #[msg("amount is below the configured minimum deposit")]
    DepositTooSmall,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("receipt mint or token program does not match configuration")]
    ReceiptConfigurationMismatch,
    #[msg("USDC mint or token program does not match configuration")]
    UsdcConfigurationMismatch,
    #[msg("player account does not belong to signer")]
    PlayerOwnerMismatch,
    #[msg("player has not refreshed entries for the active epoch")]
    EntriesNeedRefresh,
    #[msg("player has already refreshed entries for the active epoch")]
    EntriesAlreadyRefreshed,
    #[msg("position did not cover the winning tile")]
    NonWinningPosition,
    #[msg("round reward has already been claimed")]
    RoundRewardAlreadyClaimed,
    #[msg("prize amount exceeds the segregated prize vault balance")]
    PrizeUnderfunded,
    #[msg("prize snapshot must contain non-zero entry weight")]
    EmptyPrizeSnapshot,
    #[msg("prize claim deadline has not passed")]
    PrizeClaimStillOpen,
    #[msg("prize has already been claimed or expired")]
    PrizeAlreadyResolved,
    #[msg("Merkle-sum proof is invalid")]
    InvalidMerkleProof,
    #[msg("Merkle proof leaf is not the selected prize interval")]
    NonWinningPrizeProof,
    #[msg("epoch ID is not sequential")]
    NonSequentialEpoch,
    #[msg("prior epoch must be resolved before rollover")]
    PriorEpochUnresolved,
    #[msg("first epoch has already been created")]
    FirstEpochAlreadyCreated,
}
