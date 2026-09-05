pub mod constants;
pub mod errors;
pub mod state;
pub mod utils;
pub mod vrf;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022,
    token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked},
};

use crate::program::HexVault;
use constants::*;
use errors::HexVaultError;
use state::*;
use utils::*;

declare_id!("6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB");

#[program]
pub mod hex_vault {
    use super::*;

    /// Program-global initialization. Requires the deployed program's upgrade
    /// authority so the first caller cannot seize the protocol (finding I-01).
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.guardian = params.guardian;
        config.snapshot_authority = params.snapshot_authority;
        config.mock_randomness_authority = params.mock_randomness_authority;
        // Zero keeps the protocol mock-only (localnet); set to the ORAO
        // network-state account to enable the `*_with_vrf` settle path.
        config.vrf_randomness_state = params.vrf_randomness_state;
        config.production_mode = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Creates one isolated pool instance: immutable accepted asset identity,
    /// receipt mints, and the three segregated vaults.
    pub fn create_pool(ctx: Context<CreatePool>, params: CreatePoolParams) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        require!(
            params.min_deposit > 0
                && params.max_stake_per_tile > 0
                && params.max_round_bonus_entries > 0
                && params.min_epoch_seconds > 0
                && params.max_epoch_seconds >= params.min_epoch_seconds
                && params.round_close_buffer_seconds >= 0,
            HexVaultError::InvalidPoolConfiguration
        );
        // PRD §8.13: the pool's accepted mint must actually belong to the
        // declared token program — a mismatch would poison every later
        // vault/CPI validation.
        require_keys_eq!(
            *ctx.accounts.accepted_mint.to_account_info().owner,
            ctx.accounts.accepted_token_program.key(),
            HexVaultError::MintTokenProgramMismatch
        );

        create_non_transferable_mint(
            &ctx.accounts.authority,
            &ctx.accounts.principal_mint,
            &ctx.accounts.pool,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.system_program,
            ctx.accounts.accepted_mint.decimals,
        )?;
        create_non_transferable_mint(
            &ctx.accounts.authority,
            &ctx.accounts.entry_mint,
            &ctx.accounts.pool,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.system_program,
            ctx.accounts.accepted_mint.decimals,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.pool_id = params.pool_id;
        pool.paused = false;
        pool.accepted_mint = ctx.accounts.accepted_mint.key();
        pool.accepted_token_program = ctx.accounts.accepted_token_program.key();
        pool.accepted_decimals = ctx.accounts.accepted_mint.decimals;
        pool.principal_mint = ctx.accounts.principal_mint.key();
        pool.entry_mint = ctx.accounts.entry_mint.key();
        pool.principal_vault = ctx.accounts.principal_vault.key();
        pool.prize_vault = ctx.accounts.prize_vault.key();
        pool.jackpot_vault = ctx.accounts.jackpot_vault.key();
        pool.min_deposit = params.min_deposit;
        pool.max_stake_per_tile = params.max_stake_per_tile;
        pool.max_round_bonus_entries = params.max_round_bonus_entries;
        pool.min_epoch_seconds = params.min_epoch_seconds;
        pool.max_epoch_seconds = params.max_epoch_seconds;
        pool.round_close_buffer_seconds = params.round_close_buffer_seconds;
        pool.bump = ctx.bumps.pool;

        emit!(PoolCreated {
            pool: pool.key(),
            pool_id: pool.pool_id,
            accepted_mint: pool.accepted_mint,
        });
        Ok(())
    }

    /// Guardian pause is per pool. Refresh and withdrawal stay live by design.
    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.guardian.key(),
            ctx.accounts.config.guardian,
            HexVaultError::UnauthorizedGuardian
        );
        ctx.accounts.pool.paused = paused;
        emit!(ProtocolPauseChanged {
            pool: ctx.accounts.pool.key(),
            paused,
        });
        Ok(())
    }

    pub fn create_first_epoch(ctx: Context<CreateFirstEpoch>, timing: EpochTiming) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        // Window validation comes before the duplicate guard so both rules
        // stay observable; each reverts the whole transaction either way.
        validate_epoch_timing(&timing, &ctx.accounts.pool)?;
        require!(
            ctx.accounts.pool.latest_epoch_id == 0,
            HexVaultError::FirstEpochAlreadyCreated
        );
        require!(timing.id == 1, HexVaultError::NonSequentialEpoch);
        initialize_epoch(
            &mut ctx.accounts.epoch,
            &ctx.accounts.pool.key(),
            timing,
            ctx.bumps.epoch,
        );
        ctx.accounts.pool.latest_epoch_id = ctx.accounts.epoch.id;
        emit!(EpochCreated {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            starts_at: ctx.accounts.epoch.starts_at,
            entry_cutoff_at: ctx.accounts.epoch.entry_cutoff_at,
            ends_at: ctx.accounts.epoch.ends_at,
            prize_snapshot_at: ctx.accounts.epoch.prize_snapshot_at,
            claim_deadline: ctx.accounts.epoch.claim_deadline,
        });
        Ok(())
    }

    pub fn begin_next_epoch(ctx: Context<BeginNextEpoch>, timing: EpochTiming) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        require!(
            ctx.accounts.prior_epoch.id == ctx.accounts.pool.latest_epoch_id,
            HexVaultError::InactiveEpoch
        );
        require!(
            timing.id
                == ctx
                    .accounts
                    .prior_epoch
                    .id
                    .checked_add(1)
                    .ok_or(HexVaultError::ArithmeticOverflow)?,
            HexVaultError::NonSequentialEpoch
        );
        require!(
            timing.starts_at >= ctx.accounts.prior_epoch.ends_at,
            HexVaultError::InvalidTimeWindow
        );
        require!(
            ctx.accounts.prior_epoch.status == EPOCH_PRIZE_CLAIMED
                || ctx.accounts.prior_epoch.status == EPOCH_PRIZE_EXPIRED,
            HexVaultError::PriorEpochUnresolved
        );
        // A committed jackpot draw must also be resolved before rollover so two
        // epochs can never hold overlapping claims against the same vault.
        require!(
            ctx.accounts.prior_epoch.jackpot_status == JACKPOT_NONE
                || ctx.accounts.prior_epoch.jackpot_status == JACKPOT_CLAIMED
                || ctx.accounts.prior_epoch.jackpot_status == JACKPOT_EXPIRED,
            HexVaultError::InvalidJackpotState
        );
        validate_epoch_timing(&timing, &ctx.accounts.pool)?;
        initialize_epoch(
            &mut ctx.accounts.epoch,
            &ctx.accounts.pool.key(),
            timing,
            ctx.bumps.epoch,
        );
        ctx.accounts.pool.latest_epoch_id = ctx.accounts.epoch.id;
        emit!(EpochCreated {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            starts_at: ctx.accounts.epoch.starts_at,
            entry_cutoff_at: ctx.accounts.epoch.entry_cutoff_at,
            ends_at: ctx.accounts.epoch.ends_at,
            prize_snapshot_at: ctx.accounts.epoch.prize_snapshot_at,
            claim_deadline: ctx.accounts.epoch.claim_deadline,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        require!(
            amount >= ctx.accounts.pool.min_deposit,
            HexVaultError::DepositTooSmall
        );
        require!(!ctx.accounts.pool.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.pool, &ctx.accounts.epoch)?;
        let timestamp = now()?;
        require!(
            timestamp >= ctx.accounts.epoch.starts_at
                && timestamp < ctx.accounts.epoch.entry_cutoff_at,
            HexVaultError::EpochNotOpen
        );
        assert_receipt_accounts(&ctx.accounts.receipt_token_program)?;

        let player = &mut ctx.accounts.player;
        if player.owner == Pubkey::default() {
            player.pool = ctx.accounts.pool.key();
            player.owner = ctx.accounts.owner.key();
            player.last_entry_epoch_id = ctx.accounts.epoch.id;
            player.bump = ctx.bumps.player;
        } else {
            require_keys_eq!(
                player.owner,
                ctx.accounts.owner.key(),
                HexVaultError::PlayerOwnerMismatch
            );
            if player.last_entry_epoch_id < ctx.accounts.epoch.id {
                sync_entries_to_principal(
                    &ctx.accounts.pool,
                    &ctx.accounts.entry_mint,
                    &ctx.accounts.owner_principal,
                    &ctx.accounts.owner_entry,
                    &ctx.accounts.receipt_token_program,
                    &ctx.accounts.owner,
                )?;
                player.last_entry_epoch_id = ctx.accounts.epoch.id;
            }
        }

        transfer_user_to_pool_vault(
            &ctx.accounts.pool,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.owner_accepted,
            &ctx.accounts.principal_vault,
            &ctx.accounts.owner,
            amount,
        )?;
        mint_receipt(
            &ctx.accounts.pool,
            &ctx.accounts.principal_mint,
            &ctx.accounts.owner_principal,
            amount,
        )?;
        mint_receipt(
            &ctx.accounts.pool,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_entry,
            amount,
        )?;

        emit!(DepositRecorded {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            epoch_id: ctx.accounts.epoch.id,
            amount,
        });
        Ok(())
    }

    /// Deliberately allowed while paused: refreshing entries only restores the
    /// documented matched-withdrawal route (PRD principle 6). It moves no
    /// custody asset and creates no new exposure.
    pub fn refresh_entries(ctx: Context<RefreshEntries>) -> Result<()> {
        let timestamp = now()?;
        require!(
            timestamp >= ctx.accounts.epoch.starts_at
                && timestamp < ctx.accounts.epoch.entry_cutoff_at,
            HexVaultError::EpochNotOpen
        );
        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.owner.key(),
            HexVaultError::PlayerOwnerMismatch
        );
        require!(
            ctx.accounts.player.last_entry_epoch_id < ctx.accounts.epoch.id,
            HexVaultError::EntriesAlreadyRefreshed
        );
        assert_receipt_accounts(&ctx.accounts.receipt_token_program)?;

        sync_entries_to_principal(
            &ctx.accounts.pool,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_principal,
            &ctx.accounts.owner_entry,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.owner,
        )?;
        ctx.accounts.player.last_entry_epoch_id = ctx.accounts.epoch.id;
        emit!(EntriesRefreshed {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            epoch_id: ctx.accounts.epoch.id,
            principal_entries: ctx.accounts.owner_principal.amount,
        });
        Ok(())
    }

    /// Withdrawal is never blocked by pause, epoch state, or rollover.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        assert_receipt_accounts(&ctx.accounts.receipt_token_program)?;
        require!(
            ctx.accounts.owner_principal.amount >= amount
                && ctx.accounts.owner_entry.amount >= amount,
            HexVaultError::InsufficientMatchedBalance
        );

        burn_receipt(
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.principal_mint,
            &ctx.accounts.owner_principal,
            &ctx.accounts.owner,
            amount,
        )?;
        burn_receipt(
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_entry,
            &ctx.accounts.owner,
            amount,
        )?;
        transfer_pool_vault_to_user(
            &ctx.accounts.pool,
            &ctx.accounts.principal_vault,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.owner_accepted,
            amount,
        )?;

        emit!(WithdrawalRecorded {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            amount,
        });
        Ok(())
    }

    /// Sponsor/operations prize funding. The only inflow to the prize vault.
    pub fn fund_prize(ctx: Context<FundPrize>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        transfer_user_to_pool_vault(
            &ctx.accounts.pool,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.funder_accepted,
            &ctx.accounts.prize_vault,
            &ctx.accounts.funder,
            amount,
        )?;
        emit!(PrizeFunded {
            pool: ctx.accounts.pool.key(),
            funder: ctx.accounts.funder.key(),
            amount,
        });
        Ok(())
    }

    /// Sponsor/operations jackpot funding. The only inflow to the jackpot
    /// vault; no instruction can route principal or prize assets here.
    pub fn fund_jackpot(ctx: Context<FundJackpot>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        transfer_user_to_pool_vault(
            &ctx.accounts.pool,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.funder_accepted,
            &ctx.accounts.jackpot_vault,
            &ctx.accounts.funder,
            amount,
        )?;
        emit!(JackpotFunded {
            pool: ctx.accounts.pool.key(),
            funder: ctx.accounts.funder.key(),
            amount,
        });
        Ok(())
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        starts_at: i64,
        ends_at: i64,
        bonus_entries: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        require!(!ctx.accounts.pool.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.pool, &ctx.accounts.epoch)?;
        require!(starts_at < ends_at, HexVaultError::InvalidTimeWindow);
        require!(
            starts_at >= ctx.accounts.epoch.starts_at && ends_at <= ctx.accounts.epoch.ends_at,
            HexVaultError::InvalidTimeWindow
        );
        require!(
            bonus_entries <= ctx.accounts.pool.max_round_bonus_entries,
            HexVaultError::BonusEntriesExceedCap
        );
        let round = &mut ctx.accounts.round;
        round.pool = ctx.accounts.pool.key();
        round.epoch = ctx.accounts.epoch.key();
        round.epoch_id = ctx.accounts.epoch.id;
        round.id = round_id;
        round.starts_at = starts_at;
        round.ends_at = ends_at;
        round.status = ROUND_OPEN;
        round.winning_tile = u8::MAX;
        round.bonus_entries = bonus_entries;
        round.total_stake = 0;
        round.tile_stakes = [0; 36];
        round.bump = ctx.bumps.round;
        Ok(())
    }

    pub fn buy_position(ctx: Context<BuyPosition>, tiles: u64, stake_per_tile: u64) -> Result<()> {
        require!(!ctx.accounts.pool.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.pool, &ctx.accounts.epoch)?;
        require_keys_eq!(
            ctx.accounts.player.owner,
            ctx.accounts.owner.key(),
            HexVaultError::PlayerOwnerMismatch
        );
        require!(
            ctx.accounts.player.last_entry_epoch_id == ctx.accounts.epoch.id,
            HexVaultError::EntriesNeedRefresh
        );
        require!(
            ctx.accounts.round.status == ROUND_OPEN,
            HexVaultError::InvalidRoundState
        );
        require_keys_eq!(
            ctx.accounts.round.epoch,
            ctx.accounts.epoch.key(),
            HexVaultError::InactiveEpoch
        );
        let timestamp = now()?;
        let closing_time = ctx
            .accounts
            .round
            .ends_at
            .checked_sub(ctx.accounts.pool.round_close_buffer_seconds)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        require!(
            timestamp >= ctx.accounts.round.starts_at && timestamp < closing_time,
            HexVaultError::RoundClosed
        );
        require!(
            stake_per_tile > 0 && stake_per_tile <= ctx.accounts.pool.max_stake_per_tile,
            HexVaultError::InvalidStakeAmount
        );
        assert_receipt_accounts(&ctx.accounts.receipt_token_program)?;

        let count = u64::from(tile_count(tiles)?);
        let total_stake = count
            .checked_mul(stake_per_tile)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        require!(
            ctx.accounts.owner_entry.amount >= total_stake,
            HexVaultError::InsufficientEntries
        );

        burn_receipt(
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_entry,
            &ctx.accounts.owner,
            total_stake,
        )?;

        let round = &mut ctx.accounts.round;
        for tile in 0..TILE_COUNT {
            if tile_is_covered(tiles, tile) {
                let slot = &mut round.tile_stakes[usize::from(tile)];
                *slot = slot
                    .checked_add(stake_per_tile)
                    .ok_or(HexVaultError::ArithmeticOverflow)?;
            }
        }
        round.total_stake = round
            .total_stake
            .checked_add(total_stake)
            .ok_or(HexVaultError::ArithmeticOverflow)?;

        let position = &mut ctx.accounts.position;
        position.pool = ctx.accounts.pool.key();
        position.owner = ctx.accounts.owner.key();
        position.round = ctx.accounts.round.key();
        position.round_id = ctx.accounts.round.id;
        position.tiles = tiles;
        position.stake_per_tile = stake_per_tile;
        position.reward_claimed = false;
        position.bump = ctx.bumps.position;
        emit!(PositionPurchased {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.epoch.id,
            round_id: ctx.accounts.round.id,
            tiles,
            total_stake,
        });
        Ok(())
    }

    pub fn request_round_randomness(
        ctx: Context<RequestRoundRandomness>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.round.status == ROUND_OPEN,
            HexVaultError::InvalidRoundState
        );
        require!(
            now()? >= ctx.accounts.round.ends_at,
            HexVaultError::RoundClosed
        );
        ctx.accounts.round.status = ROUND_RANDOMNESS_REQUESTED;
        let request = &mut ctx.accounts.request;
        request.pool = ctx.accounts.pool.key();
        request.kind = REQUEST_ROUND;
        request.status = REQUEST_PENDING;
        request.subject = ctx.accounts.round.key();
        request.epoch_id = ctx.accounts.round.epoch_id;
        request.round_id = ctx.accounts.round.id;
        request.seed = mix_client_seed(&ctx.accounts.recent_slothaves, client_seed)?;
        request.bump = ctx.bumps.request;
        emit!(RoundRandomnessRequested {
            pool: ctx.accounts.pool.key(),
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.round.epoch_id,
            round_id: ctx.accounts.round.id,
        });
        Ok(())
    }

    pub fn fulfill_round_with_mock(ctx: Context<FulfillRoundWithMock>, sample: u64) -> Result<()> {
        require!(
            !ctx.accounts.config.production_mode,
            HexVaultError::MockRandomnessDisabled
        );
        require_keys_eq!(
            ctx.accounts.mock_randomness_authority.key(),
            ctx.accounts.config.mock_randomness_authority,
            HexVaultError::UnauthorizedMockRandomnessAuthority
        );
        require!(
            ctx.accounts.round.status == ROUND_RANDOMNESS_REQUESTED,
            HexVaultError::InvalidRoundState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_ROUND
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.round.key(),
            HexVaultError::InvalidRandomnessRequest
        );

        let tile = unbiased_index(sample, TILE_COUNT)?;
        ctx.accounts.round.winning_tile = tile;
        ctx.accounts.round.status = ROUND_SETTLED;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(RoundSettled {
            pool: ctx.accounts.pool.key(),
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.round.epoch_id,
            round_id: ctx.accounts.round.id,
            winning_tile: tile,
        });
        Ok(())
    }

    /// ET-only in-epoch reward. Proportional to stake on the winning tile;
    /// bounded by the pool bonus cap; never touches PT or any custody asset.
    pub fn claim_round_reward(ctx: Context<ClaimRoundReward>) -> Result<()> {
        require!(
            ctx.accounts.round.status == ROUND_SETTLED,
            HexVaultError::InvalidRoundState
        );
        require_keys_eq!(
            ctx.accounts.position.owner,
            ctx.accounts.owner.key(),
            HexVaultError::PlayerOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.position.round,
            ctx.accounts.round.key(),
            HexVaultError::RandomnessSubjectMismatch
        );
        require!(
            !ctx.accounts.position.reward_claimed,
            HexVaultError::RoundRewardAlreadyClaimed
        );
        let winning_tile = ctx.accounts.round.winning_tile;
        require!(
            tile_is_covered(ctx.accounts.position.tiles, winning_tile),
            HexVaultError::NonWinningPosition
        );
        let winning_total = ctx.accounts.round.tile_stakes[usize::from(winning_tile)];
        require!(winning_total > 0, HexVaultError::NonWinningPosition);
        let reward_u128 = (u128::from(ctx.accounts.round.bonus_entries)
            .checked_mul(u128::from(ctx.accounts.position.stake_per_tile))
            .ok_or(HexVaultError::ArithmeticOverflow)?)
        .checked_div(u128::from(winning_total))
        .ok_or(HexVaultError::ArithmeticOverflow)?;
        let reward = u64::try_from(reward_u128).map_err(|_| HexVaultError::ArithmeticOverflow)?;

        assert_receipt_accounts(&ctx.accounts.receipt_token_program)?;
        ctx.accounts.position.reward_claimed = true;
        if reward > 0 {
            mint_receipt(
                &ctx.accounts.pool,
                &ctx.accounts.entry_mint,
                &ctx.accounts.owner_entry,
                reward,
            )?;
        }
        emit!(RoundRewardClaimed {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            round: ctx.accounts.round.key(),
            reward,
        });
        Ok(())
    }

    pub fn commit_prize_snapshot(
        ctx: Context<CommitPrizeSnapshot>,
        root: [u8; 32],
        total_entry_weight: u64,
        prize_amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.pool.paused, HexVaultError::ProtocolPaused);
        require_keys_eq!(
            ctx.accounts.snapshot_authority.key(),
            ctx.accounts.config.snapshot_authority,
            HexVaultError::UnauthorizedSnapshotAuthority
        );
        require_active_open_epoch(&ctx.accounts.pool, &ctx.accounts.epoch)?;
        require!(
            now()? >= ctx.accounts.epoch.prize_snapshot_at,
            HexVaultError::InvalidTimeWindow
        );
        require!(total_entry_weight > 0, HexVaultError::EmptyPrizeSnapshot);
        require!(prize_amount > 0, HexVaultError::ZeroAmount);
        require!(
            ctx.accounts.prize_vault.amount >= prize_amount,
            HexVaultError::PrizeUnderfunded
        );

        let epoch = &mut ctx.accounts.epoch;
        epoch.prize_snapshot_root = root;
        epoch.total_entry_weight = total_entry_weight;
        epoch.prize_amount = prize_amount;
        epoch.status = EPOCH_SNAPSHOT_COMMITTED;
        emit!(PrizeSnapshotCommitted {
            pool: ctx.accounts.pool.key(),
            epoch_id: epoch.id,
            prize_amount,
            total_entry_weight,
            root,
        });
        Ok(())
    }

    /// Commits the current jackpot vault balance for this epoch's draw. The
    /// cohort is the committed prize snapshot; nothing about eligibility can
    /// change after this. Unclaimed jackpots roll over by simply remaining in
    /// the vault — expiry moves no funds.
    pub fn commit_jackpot(ctx: Context<CommitJackpot>) -> Result<()> {
        require!(!ctx.accounts.pool.paused, HexVaultError::ProtocolPaused);
        require_keys_eq!(
            ctx.accounts.snapshot_authority.key(),
            ctx.accounts.config.snapshot_authority,
            HexVaultError::UnauthorizedSnapshotAuthority
        );
        require!(
            ctx.accounts.epoch.status == EPOCH_SNAPSHOT_COMMITTED,
            HexVaultError::InvalidEpochState
        );
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_NONE,
            HexVaultError::JackpotAlreadyCommitted
        );
        let amount = ctx.accounts.jackpot_vault.amount;
        require!(amount > 0, HexVaultError::ZeroAmount);
        let epoch = &mut ctx.accounts.epoch;
        epoch.jackpot_status = JACKPOT_COMMITTED;
        epoch.jackpot_amount = amount;
        emit!(JackpotCommitted {
            pool: ctx.accounts.pool.key(),
            epoch_id: epoch.id,
            jackpot_amount: amount,
        });
        Ok(())
    }

    pub fn request_prize_randomness(
        ctx: Context<RequestPrizeRandomness>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.epoch.status == EPOCH_SNAPSHOT_COMMITTED,
            HexVaultError::InvalidEpochState
        );
        let request = &mut ctx.accounts.request;
        request.pool = ctx.accounts.pool.key();
        request.kind = REQUEST_PRIZE;
        request.status = REQUEST_PENDING;
        request.subject = ctx.accounts.epoch.key();
        request.epoch_id = ctx.accounts.epoch.id;
        request.round_id = 0;
        request.seed = mix_client_seed(&ctx.accounts.recent_slothaves, client_seed)?;
        request.bump = ctx.bumps.request;
        ctx.accounts.epoch.status = EPOCH_RANDOMNESS_REQUESTED;
        emit!(PrizeRandomnessRequested {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
        });
        Ok(())
    }

    pub fn request_jackpot_randomness(
        ctx: Context<RequestJackpotRandomness>,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_COMMITTED,
            HexVaultError::InvalidJackpotState
        );
        let request = &mut ctx.accounts.request;
        request.pool = ctx.accounts.pool.key();
        request.kind = REQUEST_JACKPOT;
        request.status = REQUEST_PENDING;
        request.subject = ctx.accounts.epoch.key();
        request.epoch_id = ctx.accounts.epoch.id;
        request.round_id = 0;
        request.seed = mix_client_seed(&ctx.accounts.recent_slothaves, client_seed)?;
        request.bump = ctx.bumps.request;
        emit!(JackpotRandomnessRequested {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
        });
        Ok(())
    }

    pub fn fulfill_prize_with_mock(ctx: Context<FulfillPrizeWithMock>, sample: u64) -> Result<()> {
        require!(
            !ctx.accounts.config.production_mode,
            HexVaultError::MockRandomnessDisabled
        );
        require_keys_eq!(
            ctx.accounts.mock_randomness_authority.key(),
            ctx.accounts.config.mock_randomness_authority,
            HexVaultError::UnauthorizedMockRandomnessAuthority
        );
        require!(
            ctx.accounts.epoch.status == EPOCH_RANDOMNESS_REQUESTED,
            HexVaultError::InvalidEpochState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_PRIZE
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.epoch.key(),
            HexVaultError::InvalidRandomnessRequest
        );

        let target = unbiased_u64(sample, ctx.accounts.epoch.total_entry_weight)?;
        ctx.accounts.epoch.prize_target = target;
        ctx.accounts.epoch.status = EPOCH_PRIZE_DRAWN;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(PrizeDrawn {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            target,
        });
        Ok(())
    }

    pub fn fulfill_jackpot_with_mock(
        ctx: Context<FulfillJackpotWithMock>,
        sample: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.production_mode,
            HexVaultError::MockRandomnessDisabled
        );
        require_keys_eq!(
            ctx.accounts.mock_randomness_authority.key(),
            ctx.accounts.config.mock_randomness_authority,
            HexVaultError::UnauthorizedMockRandomnessAuthority
        );
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_COMMITTED,
            HexVaultError::InvalidJackpotState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_JACKPOT
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.epoch.key(),
            HexVaultError::InvalidRandomnessRequest
        );

        let target = unbiased_u64(sample, ctx.accounts.epoch.total_entry_weight)?;
        ctx.accounts.epoch.jackpot_target = target;
        ctx.accounts.epoch.jackpot_status = JACKPOT_DRAWN;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(JackpotDrawn {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            target,
        });
        Ok(())
    }

    /// Permissionless round settle from the ORAO VRF (pull model). Anyone may
    /// submit once the oracle network has fulfilled the request bound to this
    /// round's stored seed; the winning tile derives from oracle-signed
    /// randomness, never from the submitter.
    pub fn fulfill_round_with_vrf(ctx: Context<FulfillRoundWithVrf>) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.config.vrf_randomness_state,
            Pubkey::default(),
            HexVaultError::VrfRandomnessDisabled
        );
        require!(
            ctx.accounts.round.status == ROUND_RANDOMNESS_REQUESTED,
            HexVaultError::InvalidRoundState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_ROUND
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.round.key(),
            HexVaultError::InvalidRandomnessRequest
        );
        require_keys_eq!(
            ctx.accounts.orao_request.key(),
            crate::vrf::orao_request_address(
                &ctx.accounts.orao_network_state.key(),
                &ctx.accounts.request.seed,
            ),
            HexVaultError::InvalidRandomnessAccount
        );

        let randomness =
            crate::vrf::parse_fulfilled(&ctx.accounts.orao_request.try_borrow_data()?)?;
        // Rejection-tail safe: re-derives in-program, never strands the round.
        let (index, _) = crate::vrf::unbiased_from_randomness(&randomness, u64::from(TILE_COUNT))?;
        let tile = u8::try_from(index).map_err(|_| HexVaultError::RandomnessRejection)?;
        ctx.accounts.round.winning_tile = tile;
        ctx.accounts.round.status = ROUND_SETTLED;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(RoundSettled {
            pool: ctx.accounts.pool.key(),
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.round.epoch_id,
            round_id: ctx.accounts.round.id,
            winning_tile: tile,
        });
        Ok(())
    }

    /// Permissionless prize draw from the ORAO VRF (see
    /// `fulfill_round_with_vrf` for the trust model).
    pub fn fulfill_prize_with_vrf(ctx: Context<FulfillPrizeWithVrf>) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.config.vrf_randomness_state,
            Pubkey::default(),
            HexVaultError::VrfRandomnessDisabled
        );
        require!(
            ctx.accounts.epoch.status == EPOCH_RANDOMNESS_REQUESTED,
            HexVaultError::InvalidEpochState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_PRIZE
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.epoch.key(),
            HexVaultError::InvalidRandomnessRequest
        );
        require_keys_eq!(
            ctx.accounts.orao_request.key(),
            crate::vrf::orao_request_address(
                &ctx.accounts.orao_network_state.key(),
                &ctx.accounts.request.seed,
            ),
            HexVaultError::InvalidRandomnessAccount
        );

        let randomness =
            crate::vrf::parse_fulfilled(&ctx.accounts.orao_request.try_borrow_data()?)?;
        // Rejection-tail safe (see fulfill_round_with_vrf).
        let (target, _) = crate::vrf::unbiased_from_randomness(
            &randomness,
            ctx.accounts.epoch.total_entry_weight,
        )?;
        ctx.accounts.epoch.prize_target = target;
        ctx.accounts.epoch.status = EPOCH_PRIZE_DRAWN;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(PrizeDrawn {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            target,
        });
        Ok(())
    }

    /// Permissionless jackpot draw from the ORAO VRF (see
    /// `fulfill_round_with_vrf` for the trust model).
    pub fn fulfill_jackpot_with_vrf(ctx: Context<FulfillJackpotWithVrf>) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.config.vrf_randomness_state,
            Pubkey::default(),
            HexVaultError::VrfRandomnessDisabled
        );
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_COMMITTED,
            HexVaultError::InvalidJackpotState
        );
        require!(
            ctx.accounts.request.kind == REQUEST_JACKPOT
                && ctx.accounts.request.status == REQUEST_PENDING
                && ctx.accounts.request.subject == ctx.accounts.epoch.key(),
            HexVaultError::InvalidRandomnessRequest
        );
        require_keys_eq!(
            ctx.accounts.orao_request.key(),
            crate::vrf::orao_request_address(
                &ctx.accounts.orao_network_state.key(),
                &ctx.accounts.request.seed,
            ),
            HexVaultError::InvalidRandomnessAccount
        );

        let randomness =
            crate::vrf::parse_fulfilled(&ctx.accounts.orao_request.try_borrow_data()?)?;
        // Rejection-tail safe (see fulfill_round_with_vrf).
        let (target, _) = crate::vrf::unbiased_from_randomness(
            &randomness,
            ctx.accounts.epoch.total_entry_weight,
        )?;
        ctx.accounts.epoch.jackpot_target = target;
        ctx.accounts.epoch.jackpot_status = JACKPOT_DRAWN;
        ctx.accounts.request.status = REQUEST_FULFILLED;
        emit!(JackpotDrawn {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            target,
        });
        Ok(())
    }

    pub fn claim_prize(
        ctx: Context<ClaimPrize>,
        weight: u64,
        proof: Vec<MerkleProofNode>,
    ) -> Result<()> {
        require!(
            ctx.accounts.epoch.status == EPOCH_PRIZE_DRAWN,
            HexVaultError::PrizeAlreadyResolved
        );
        require!(
            now()? < ctx.accounts.epoch.claim_deadline,
            HexVaultError::PrizeClaimStillOpen
        );
        let prefix = verify_prize_proof(
            ctx.accounts.epoch.prize_snapshot_root,
            ctx.accounts.epoch.total_entry_weight,
            &ctx.accounts.winner.key(),
            weight,
            &proof,
        )?;
        assert_winning_interval(prefix, weight, ctx.accounts.epoch.prize_target)?;
        require!(
            ctx.accounts.prize_vault.amount >= ctx.accounts.epoch.prize_amount,
            HexVaultError::PrizeUnderfunded
        );

        let amount = ctx.accounts.epoch.prize_amount;
        transfer_pool_vault_to_user(
            &ctx.accounts.pool,
            &ctx.accounts.prize_vault,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.winner_accepted,
            amount,
        )?;
        ctx.accounts.epoch.status = EPOCH_PRIZE_CLAIMED;
        emit!(PrizeClaimed {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            winner: ctx.accounts.winner.key(),
            amount,
        });
        Ok(())
    }

    /// Pays the committed jackpot to the snapshot-proven winner of the jackpot
    /// target interval. One claim; never falls back to any other escrow.
    pub fn claim_jackpot(
        ctx: Context<ClaimJackpot>,
        weight: u64,
        proof: Vec<MerkleProofNode>,
    ) -> Result<()> {
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_DRAWN,
            HexVaultError::InvalidJackpotState
        );
        require!(
            now()? < ctx.accounts.epoch.claim_deadline,
            HexVaultError::PrizeClaimStillOpen
        );
        let prefix = verify_prize_proof(
            ctx.accounts.epoch.prize_snapshot_root,
            ctx.accounts.epoch.total_entry_weight,
            &ctx.accounts.winner.key(),
            weight,
            &proof,
        )?;
        assert_winning_interval(prefix, weight, ctx.accounts.epoch.jackpot_target)?;
        require!(
            ctx.accounts.jackpot_vault.amount >= ctx.accounts.epoch.jackpot_amount,
            HexVaultError::PrizeUnderfunded
        );

        let amount = ctx.accounts.epoch.jackpot_amount;
        transfer_pool_vault_to_user(
            &ctx.accounts.pool,
            &ctx.accounts.jackpot_vault,
            &ctx.accounts.accepted_mint,
            &ctx.accounts.winner_accepted,
            amount,
        )?;
        ctx.accounts.epoch.jackpot_status = JACKPOT_CLAIMED;
        emit!(JackpotClaimed {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
            winner: ctx.accounts.winner.key(),
            amount,
        });
        Ok(())
    }

    /// Expiry also cancels a stuck randomness request (requested but never
    /// fulfilled): without this a stalled authority could block rollover for
    /// the pool forever. A late fulfillment is rejected by the status change.
    pub fn expire_unclaimed_prize(ctx: Context<ExpireUnclaimedPrize>) -> Result<()> {
        require!(
            ctx.accounts.epoch.status == EPOCH_SNAPSHOT_COMMITTED
                || ctx.accounts.epoch.status == EPOCH_RANDOMNESS_REQUESTED
                || ctx.accounts.epoch.status == EPOCH_PRIZE_DRAWN,
            HexVaultError::PrizeAlreadyResolved
        );
        require!(
            now()? >= ctx.accounts.epoch.claim_deadline,
            HexVaultError::PrizeClaimStillOpen
        );
        ctx.accounts.epoch.status = EPOCH_PRIZE_EXPIRED;
        emit!(PrizeExpired {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
        });
        Ok(())
    }

    /// Unclaimed jackpots move no funds: the balance simply remains in the
    /// vault and rolls into a future epoch's commit. Accepts COMMITTED so a
    /// never-fulfilled jackpot draw cannot block rollover either.
    pub fn expire_jackpot(ctx: Context<ExpireJackpot>) -> Result<()> {
        require!(
            ctx.accounts.epoch.jackpot_status == JACKPOT_COMMITTED
                || ctx.accounts.epoch.jackpot_status == JACKPOT_DRAWN,
            HexVaultError::InvalidJackpotState
        );
        require!(
            now()? >= ctx.accounts.epoch.claim_deadline,
            HexVaultError::PrizeClaimStillOpen
        );
        ctx.accounts.epoch.jackpot_status = JACKPOT_EXPIRED;
        emit!(JackpotExpired {
            pool: ctx.accounts.pool.key(),
            epoch_id: ctx.accounts.epoch.id,
        });
        Ok(())
    }
}

fn initialize_epoch(epoch: &mut Epoch, pool_key: &Pubkey, timing: EpochTiming, bump: u8) {
    epoch.pool = *pool_key;
    epoch.id = timing.id;
    epoch.starts_at = timing.starts_at;
    epoch.entry_cutoff_at = timing.entry_cutoff_at;
    epoch.ends_at = timing.ends_at;
    epoch.prize_snapshot_at = timing.prize_snapshot_at;
    epoch.claim_deadline = timing.claim_deadline;
    epoch.status = EPOCH_OPEN;
    epoch.prize_snapshot_root = [0; 32];
    epoch.total_entry_weight = 0;
    epoch.prize_amount = 0;
    epoch.prize_target = 0;
    epoch.jackpot_status = JACKPOT_NONE;
    epoch.jackpot_amount = 0;
    epoch.jackpot_target = 0;
    epoch.bump = bump;
}

/// Creates a non-transferable Token-2022 receipt mint whose mint authority is
/// the pool PDA. The pool PDA must already exist and carry its bump.
fn create_non_transferable_mint<'info>(
    payer: &Signer<'info>,
    mint: &Signer<'info>,
    pool: &Account<'info, Pool>,
    receipt_token_program: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    decimals: u8,
) -> Result<()> {
    use token_interface::spl_token_2022::{extension::ExtensionType, state::Mint as Token2022Mint};

    let space = ExtensionType::try_calculate_account_len::<Token2022Mint>(&[
        ExtensionType::NonTransferable,
    ])?;
    let rent_exempt_balance = Rent::get()?.minimum_balance(space);
    anchor_lang::system_program::create_account(
        CpiContext::new(
            system_program.key(),
            anchor_lang::system_program::CreateAccount {
                from: payer.to_account_info(),
                to: mint.to_account_info(),
            },
        ),
        rent_exempt_balance,
        u64::try_from(space).map_err(|_| HexVaultError::ArithmeticOverflow)?,
        &token_2022::ID,
    )?;
    token_interface::non_transferable_mint_initialize(CpiContext::new(
        receipt_token_program.key(),
        token_interface::NonTransferableMintInitialize {
            token_program_id: receipt_token_program.to_account_info(),
            mint: mint.to_account_info(),
        },
    ))?;
    token_2022::initialize_mint2(
        CpiContext::new(
            receipt_token_program.key(),
            token_2022::InitializeMint2 {
                mint: mint.to_account_info(),
            },
        ),
        decimals,
        &pool.key(),
        None,
    )
}

/// Receipts are always Token-2022 non-transferable mints owned by the pool.
/// Context constraints pin the mint addresses to the pool record; this is the
/// instruction-body defense-in-depth for the program id itself.
fn assert_receipt_accounts(receipt_token_program: &Interface<TokenInterface>) -> Result<()> {
    require_keys_eq!(
        receipt_token_program.key(),
        token_2022::ID,
        HexVaultError::ReceiptConfigurationMismatch
    );
    Ok(())
}

/// Signer seeds for the pool PDA. Returned owned so the borrowed slices used
/// in the CPI context outlive the call expression.
fn pool_signer_seeds(pool: &Pool) -> [Vec<u8>; 3] {
    [
        b"pool".to_vec(),
        pool.pool_id.to_le_bytes().to_vec(),
        [pool.bump].to_vec(),
    ]
}

fn pool_signer<'a>(seeds: &'a [Vec<u8>; 3]) -> [&'a [u8]; 3] {
    [&seeds[0], &seeds[1], &seeds[2]]
}

fn mint_receipt<'info>(
    pool: &Account<'info, Pool>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    destination: &Box<InterfaceAccount<'info, TokenAccount>>,
    amount: u64,
) -> Result<()> {
    let seeds = pool_signer_seeds(pool);
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_2022::ID,
            MintTo {
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[&pool_signer(&seeds)],
        ),
        amount,
    )
}

fn burn_receipt<'info>(
    receipt_token_program: &Interface<'info, TokenInterface>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    source: &Box<InterfaceAccount<'info, TokenAccount>>,
    owner: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token_interface::burn(
        CpiContext::new(
            receipt_token_program.key(),
            Burn {
                mint: mint.to_account_info(),
                from: source.to_account_info(),
                authority: owner.to_account_info(),
            },
        ),
        amount,
    )
}

fn transfer_user_to_pool_vault<'info>(
    pool: &Account<'info, Pool>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    from: &Box<InterfaceAccount<'info, TokenAccount>>,
    to: &Box<InterfaceAccount<'info, TokenAccount>>,
    from_authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            pool.accepted_token_program,
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: from_authority.to_account_info(),
            },
        ),
        amount,
        pool.accepted_decimals,
    )
}

fn transfer_pool_vault_to_user<'info>(
    pool: &Account<'info, Pool>,
    from: &Box<InterfaceAccount<'info, TokenAccount>>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    to: &Box<InterfaceAccount<'info, TokenAccount>>,
    amount: u64,
) -> Result<()> {
    let seeds = pool_signer_seeds(pool);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            pool.accepted_token_program,
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[&pool_signer(&seeds)],
        ),
        amount,
        pool.accepted_decimals,
    )
}

fn sync_entries_to_principal<'info>(
    pool: &Account<'info, Pool>,
    entry_mint: &Box<InterfaceAccount<'info, Mint>>,
    owner_principal: &Box<InterfaceAccount<'info, TokenAccount>>,
    owner_entry: &Box<InterfaceAccount<'info, TokenAccount>>,
    receipt_token_program: &Interface<'info, TokenInterface>,
    owner: &Signer<'info>,
) -> Result<()> {
    let principal = owner_principal.amount;
    let entries = owner_entry.amount;
    if principal > entries {
        mint_receipt(
            pool,
            entry_mint,
            owner_entry,
            principal
                .checked_sub(entries)
                .ok_or(HexVaultError::ArithmeticOverflow)?,
        )
    } else if entries > principal {
        burn_receipt(
            receipt_token_program,
            entry_mint,
            owner_entry,
            owner,
            entries
                .checked_sub(principal)
                .ok_or(HexVaultError::ArithmeticOverflow)?,
        )
    } else {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, seeds = [b"config".as_ref()], bump, space = 8 + ProtocolConfig::INIT_SPACE)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ HexVaultError::UnauthorizedAuthority)]
    pub program: Program<'info, HexVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ HexVaultError::UnauthorizedAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: CreatePoolParams)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(init, payer = authority, seeds = [b"pool".as_ref(), &params.pool_id.to_le_bytes()], bump, space = 8 + Pool::INIT_SPACE)]
    pub pool: Box<Account<'info, Pool>>,
    /// Any SPL/Token-2022 mint may be recorded at pool creation; asset
    /// selection is a policy decision enforced at the authority, and the
    /// identity below is immutable afterwards.
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    pub accepted_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub principal_mint: Signer<'info>,
    #[account(mut)]
    pub entry_mint: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"principal-vault".as_ref(), pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = accepted_token_program
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"prize-vault".as_ref(), pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = accepted_token_program
    )]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        seeds = [b"jackpot-vault".as_ref(), pool.key().as_ref()],
        bump,
        token::mint = accepted_mint,
        token::authority = pool,
        token::token_program = accepted_token_program
    )]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: fixed Token-2022 program account; validated by address below.
    #[account(address = token_2022::ID)]
    pub receipt_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub guardian: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
#[instruction(timing: EpochTiming)]
pub struct CreateFirstEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = authority, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &timing.id.to_le_bytes()], bump, space = 8 + Epoch::INIT_SPACE)]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(timing: EpochTiming)]
pub struct BeginNextEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"epoch".as_ref(), pool.key().as_ref(), &prior_epoch.id.to_le_bytes()], bump = prior_epoch.bump)]
    pub prior_epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = authority, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &timing.id.to_le_bytes()], bump, space = 8 + Epoch::INIT_SPACE)]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init_if_needed, payer = owner, seeds = [b"player".as_ref(), pool.key().as_ref(), owner.key().as_ref()], bump, space = 8 + Player::INIT_SPACE)]
    pub player: Box<Account<'info, Player>>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = owner, token::token_program = pool.accepted_token_program)]
    pub owner_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.principal_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshEntries<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"player".as_ref(), pool.key().as_ref(), owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, address = pool.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = owner, token::token_program = pool.accepted_token_program)]
    pub owner_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.principal_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FundPrize<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = funder, token::token_program = pool.accepted_token_program)]
    pub funder_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.prize_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FundJackpot<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = funder, token::token_program = pool.accepted_token_program)]
    pub funder_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.jackpot_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = authority, seeds = [b"round".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes(), &round_id.to_le_bytes()], bump, space = 8 + Round::INIT_SPACE)]
    pub round: Box<Account<'info, Round>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"player".as_ref(), pool.key().as_ref(), owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [b"round".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = owner, seeds = [b"position".as_ref(), pool.key().as_ref(), round.key().as_ref(), owner.key().as_ref()], bump, space = 8 + Position::INIT_SPACE)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRoundRandomness<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"round".as_ref(), pool.key().as_ref(), &round.epoch_id.to_le_bytes(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = requester, seeds = [b"randomness".as_ref(), pool.key().as_ref(), round.key().as_ref(), &[REQUEST_ROUND]], bump, space = 8 + RandomnessRequest::INIT_SPACE)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: SlotHashes sysvar; parsed manually (newest entry) for seed
    /// mixing so the final seed is unknowable before this transaction lands.
    #[account(address = crate::vrf::SLOTHASHES_SYSVAR_ID)]
    pub recent_slothaves: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillRoundWithMock<'info> {
    pub mock_randomness_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"round".as_ref(), pool.key().as_ref(), &round.epoch_id.to_le_bytes(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), round.key().as_ref(), &[REQUEST_ROUND]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
}

#[derive(Accounts)]
pub struct ClaimRoundReward<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"round".as_ref(), pool.key().as_ref(), &round.epoch_id.to_le_bytes(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"position".as_ref(), pool.key().as_ref(), round.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = pool.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CommitPrizeSnapshot<'info> {
    pub snapshot_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, address = pool.prize_vault @ HexVaultError::PoolMismatch)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct CommitJackpot<'info> {
    pub snapshot_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(address = pool.jackpot_vault @ HexVaultError::PoolMismatch)]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct RequestPrizeRandomness<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = requester, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_PRIZE]], bump, space = 8 + RandomnessRequest::INIT_SPACE)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: SlotHashes sysvar; parsed manually (newest entry) for seed
    /// mixing so the final seed is unknowable before this transaction lands.
    #[account(address = crate::vrf::SLOTHASHES_SYSVAR_ID)]
    pub recent_slothaves: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestJackpotRandomness<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = requester, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_JACKPOT]], bump, space = 8 + RandomnessRequest::INIT_SPACE)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: SlotHashes sysvar; parsed manually (newest entry) for seed
    /// mixing so the final seed is unknowable before this transaction lands.
    #[account(address = crate::vrf::SLOTHASHES_SYSVAR_ID)]
    pub recent_slothaves: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillPrizeWithMock<'info> {
    pub mock_randomness_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_PRIZE]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
}

#[derive(Accounts)]
pub struct FulfillJackpotWithMock<'info> {
    pub mock_randomness_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_JACKPOT]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
}

#[derive(Accounts)]
pub struct FulfillRoundWithVrf<'info> {
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"round".as_ref(), pool.key().as_ref(), &round.epoch_id.to_le_bytes(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), round.key().as_ref(), &[REQUEST_ROUND]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: pinned to `config.vrf_randomness_state` and owned by the ORAO
    /// program (both constraints below); no caller-supplied network state
    /// can stand in, even one that ORAO genuinely owns.
    #[account(
        owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount,
        address = config.vrf_randomness_state @ HexVaultError::InvalidRandomnessAccount
    )]
    pub orao_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO-owned request PDA bound to this request's stored seed —
    /// the handler verifies the exact derivation; bytes are parsed by
    /// `crate::vrf::parse_fulfilled` (discriminator + fulfilled tag only).
    #[account(owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount)]
    pub orao_request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FulfillPrizeWithVrf<'info> {
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_PRIZE]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: pinned to `config.vrf_randomness_state` and owned by the ORAO
    /// program (both constraints below); no caller-supplied network state
    /// can stand in, even one that ORAO genuinely owns.
    #[account(
        owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount,
        address = config.vrf_randomness_state @ HexVaultError::InvalidRandomnessAccount
    )]
    pub orao_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO-owned request PDA bound to this request's stored seed —
    /// the handler verifies the exact derivation; bytes are parsed by
    /// `crate::vrf::parse_fulfilled` (discriminator + fulfilled tag only).
    #[account(owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount)]
    pub orao_request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FulfillJackpotWithVrf<'info> {
    pub requester: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"randomness".as_ref(), pool.key().as_ref(), epoch.key().as_ref(), &[REQUEST_JACKPOT]], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    /// CHECK: pinned to `config.vrf_randomness_state` and owned by the ORAO
    /// program (both constraints below); no caller-supplied network state
    /// can stand in, even one that ORAO genuinely owns.
    #[account(
        owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount,
        address = config.vrf_randomness_state @ HexVaultError::InvalidRandomnessAccount
    )]
    pub orao_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO-owned request PDA bound to this request's stored seed —
    /// the handler verifies the exact derivation; bytes are parsed by
    /// `crate::vrf::parse_fulfilled` (discriminator + fulfilled tag only).
    #[account(owner = crate::vrf::ORAO_VRF_PROGRAM_ID @ HexVaultError::InvalidRandomnessAccount)]
    pub orao_request: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: Merkle proof verifies this recipient's public key; no signature is required for relayed claims.
    pub winner: UncheckedAccount<'info>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = winner, token::token_program = pool.accepted_token_program)]
    pub winner_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.prize_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimJackpot<'info> {
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: Merkle proof verifies this recipient's public key; no signature is required for relayed claims.
    pub winner: UncheckedAccount<'info>,
    #[account(address = pool.accepted_mint @ HexVaultError::PoolMismatch)]
    pub accepted_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = accepted_mint, token::authority = winner, token::token_program = pool.accepted_token_program)]
    pub winner_accepted: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.jackpot_vault @ HexVaultError::PoolMismatch, token::mint = accepted_mint, token::authority = pool, token::token_program = accepted_token_program)]
    pub jackpot_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = pool.accepted_token_program @ HexVaultError::PoolMismatch)]
    pub accepted_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExpireUnclaimedPrize<'info> {
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
}

#[derive(Accounts)]
pub struct ExpireJackpot<'info> {
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"pool".as_ref(), &pool.pool_id.to_le_bytes()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"epoch".as_ref(), pool.key().as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_tile_samples_without_modulo_bias() {
        assert_eq!(unbiased_index(0, TILE_COUNT).unwrap(), 0);
        assert_eq!(unbiased_index(35, TILE_COUNT).unwrap(), 35);
        assert!(unbiased_index(u64::MAX, TILE_COUNT).is_err());
    }

    #[test]
    fn verifies_merkle_sum_intervals() {
        let alice = Pubkey::new_unique();
        let bob = Pubkey::new_unique();
        let alice_weight = 50;
        let bob_weight = 100;
        let alice_leaf = prize_leaf_hash(&alice, alice_weight);
        let bob_leaf = prize_leaf_hash(&bob, bob_weight);
        let root = prize_node_hash(&alice_leaf, alice_weight, &bob_leaf, bob_weight);

        let alice_prefix = verify_prize_proof(
            root,
            150,
            &alice,
            alice_weight,
            &[MerkleProofNode {
                sibling_hash: bob_leaf,
                sibling_sum: bob_weight,
                sibling_is_left: false,
            }],
        )
        .unwrap();
        assert_eq!(alice_prefix, 0);
        assert_winning_interval(alice_prefix, alice_weight, 49).unwrap();
        assert!(assert_winning_interval(alice_prefix, alice_weight, 50).is_err());

        let bob_prefix = verify_prize_proof(
            root,
            150,
            &bob,
            bob_weight,
            &[MerkleProofNode {
                sibling_hash: alice_leaf,
                sibling_sum: alice_weight,
                sibling_is_left: true,
            }],
        )
        .unwrap();
        assert_eq!(bob_prefix, 50);
        assert_winning_interval(bob_prefix, bob_weight, 149).unwrap();
    }

    #[test]
    fn epoch_timing_requires_full_ordering_and_pool_bounds() {
        let pool = Pool {
            pool_id: 1,
            paused: false,
            accepted_mint: Pubkey::new_unique(),
            accepted_token_program: token_2022::ID,
            accepted_decimals: 6,
            principal_mint: Pubkey::new_unique(),
            entry_mint: Pubkey::new_unique(),
            principal_vault: Pubkey::new_unique(),
            prize_vault: Pubkey::new_unique(),
            jackpot_vault: Pubkey::new_unique(),
            min_deposit: 1,
            max_stake_per_tile: 1,
            max_round_bonus_entries: 1,
            min_epoch_seconds: 60,
            max_epoch_seconds: 60 * 60 * 24 * 35,
            round_close_buffer_seconds: 0,
            latest_epoch_id: 1,
            bump: 255,
        };
        let base = EpochTiming {
            id: 1,
            starts_at: 1_000,
            entry_cutoff_at: 1_800,
            ends_at: 2_000,
            prize_snapshot_at: 2_000,
            claim_deadline: 3_000,
        };
        assert!(validate_epoch_timing(&base, &pool).is_ok());

        // cutoff not strictly after start
        assert!(validate_epoch_timing(
            &EpochTiming {
                entry_cutoff_at: 1_000,
                ..base.clone()
            },
            &pool
        )
        .is_err());
        // cutoff after end
        assert!(validate_epoch_timing(
            &EpochTiming {
                entry_cutoff_at: 2_500,
                ..base.clone()
            },
            &pool
        )
        .is_err());
        // snapshot before end
        assert!(validate_epoch_timing(
            &EpochTiming {
                prize_snapshot_at: 1_900,
                ..base.clone()
            },
            &pool
        )
        .is_err());
        // deadline before snapshot
        assert!(validate_epoch_timing(
            &EpochTiming {
                claim_deadline: 1_999,
                ..base.clone()
            },
            &pool
        )
        .is_err());
        // duration below pool minimum
        assert!(validate_epoch_timing(
            &EpochTiming {
                entry_cutoff_at: 1_010,
                ends_at: 1_020,
                prize_snapshot_at: 1_020,
                claim_deadline: 1_030,
                ..base.clone()
            },
            &pool
        )
        .is_err());
        // duration above pool maximum
        assert!(validate_epoch_timing(
            &EpochTiming {
                entry_cutoff_at: 1_500,
                ends_at: 1_000 + 60 * 60 * 24 * 40,
                prize_snapshot_at: 1_000 + 60 * 60 * 24 * 40,
                claim_deadline: 1_000 + 60 * 60 * 24 * 41,
                ..base
            },
            &pool
        )
        .is_err());
    }
}
