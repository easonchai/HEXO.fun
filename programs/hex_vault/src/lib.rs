pub mod constants;
pub mod errors;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token, token_2022,
    token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked},
};

use constants::*;
use errors::HexVaultError;
use state::*;
use utils::*;

declare_id!("6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB");

#[program]
pub mod hex_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        require!(params.min_deposit > 0, HexVaultError::ZeroAmount);
        require!(
            params.max_stake_per_tile > 0,
            HexVaultError::InvalidStakeAmount
        );
        require!(
            params.round_close_buffer_seconds >= 0,
            HexVaultError::InvalidTimeWindow
        );
        require!(
            ctx.accounts.usdc_mint.decimals == USDC_DECIMALS,
            HexVaultError::UsdcConfigurationMismatch
        );

        create_non_transferable_mint(
            &ctx.accounts.authority,
            &ctx.accounts.principal_mint,
            &ctx.accounts.config,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.system_program,
        )?;
        create_non_transferable_mint(
            &ctx.accounts.authority,
            &ctx.accounts.entry_mint,
            &ctx.accounts.config,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.system_program,
        )?;

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.guardian = params.guardian;
        config.snapshot_authority = params.snapshot_authority;
        config.mock_randomness_authority = params.mock_randomness_authority;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.usdc_token_program = ctx.accounts.usdc_token_program.key();
        config.receipt_token_program = ctx.accounts.receipt_token_program.key();
        config.principal_mint = ctx.accounts.principal_mint.key();
        config.entry_mint = ctx.accounts.entry_mint.key();
        config.principal_vault = ctx.accounts.principal_vault.key();
        config.prize_vault = ctx.accounts.prize_vault.key();
        config.current_epoch_id = 0;
        config.min_deposit = params.min_deposit;
        config.max_stake_per_tile = params.max_stake_per_tile;
        config.round_close_buffer_seconds = params.round_close_buffer_seconds;
        // This implementation exposes only mock fulfillment for test/devnet.
        // A production provider must be added in a separately audited upgrade.
        config.production_mode = false;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.guardian.key(),
            ctx.accounts.config.guardian,
            HexVaultError::UnauthorizedGuardian
        );
        ctx.accounts.config.paused = paused;
        emit!(ProtocolPauseChanged { paused });
        Ok(())
    }

    pub fn create_first_epoch(ctx: Context<CreateFirstEpoch>, timing: EpochTiming) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        require!(
            ctx.accounts.config.current_epoch_id == 0,
            HexVaultError::FirstEpochAlreadyCreated
        );
        validate_epoch_timing(&timing)?;
        initialize_epoch(&mut ctx.accounts.epoch, timing, ctx.bumps.epoch);
        ctx.accounts.config.current_epoch_id = ctx.accounts.epoch.id;
        Ok(())
    }

    pub fn begin_next_epoch(ctx: Context<BeginNextEpoch>, timing: EpochTiming) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.authority,
            HexVaultError::UnauthorizedAuthority
        );
        require!(
            ctx.accounts.prior_epoch.id == ctx.accounts.config.current_epoch_id,
            HexVaultError::InactiveEpoch
        );
        require!(
            ctx.accounts.prior_epoch.status == EPOCH_PRIZE_CLAIMED
                || ctx.accounts.prior_epoch.status == EPOCH_PRIZE_EXPIRED,
            HexVaultError::PriorEpochUnresolved
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
        validate_epoch_timing(&timing)?;
        initialize_epoch(&mut ctx.accounts.epoch, timing, ctx.bumps.epoch);
        ctx.accounts.config.current_epoch_id = ctx.accounts.epoch.id;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        require!(
            amount >= ctx.accounts.config.min_deposit,
            HexVaultError::DepositTooSmall
        );
        require!(!ctx.accounts.config.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.config, &ctx.accounts.epoch)?;
        require!(
            now()? >= ctx.accounts.epoch.starts_at,
            HexVaultError::EpochNotOpen
        );
        require!(
            now()? < ctx.accounts.epoch.ends_at,
            HexVaultError::EpochNotOpen
        );
        assert_receipt_accounts(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.receipt_token_program,
        )?;
        assert_usdc_accounts(
            &ctx.accounts.config,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.usdc_token_program,
        )?;

        let player = &mut ctx.accounts.player;
        if player.owner == Pubkey::default() {
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
                    &ctx.accounts.config,
                    &ctx.accounts.principal_mint,
                    &ctx.accounts.entry_mint,
                    &ctx.accounts.owner_principal,
                    &ctx.accounts.owner_entry,
                    &ctx.accounts.receipt_token_program,
                    &ctx.accounts.owner,
                )?;
                player.last_entry_epoch_id = ctx.accounts.epoch.id;
            }
            require!(
                player.last_entry_epoch_id == ctx.accounts.epoch.id,
                HexVaultError::EntriesNeedRefresh
            );
        }

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.usdc_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.owner_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.principal_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
        mint_receipt(
            &ctx.accounts.config,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.principal_mint,
            &ctx.accounts.owner_principal,
            amount,
        )?;
        mint_receipt(
            &ctx.accounts.config,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_entry,
            amount,
        )?;

        emit!(DepositRecorded {
            owner: ctx.accounts.owner.key(),
            epoch_id: ctx.accounts.epoch.id,
            amount,
        });
        Ok(())
    }

    pub fn refresh_entries(ctx: Context<RefreshEntries>) -> Result<()> {
        require!(!ctx.accounts.config.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.config, &ctx.accounts.epoch)?;
        require!(
            now()? >= ctx.accounts.epoch.starts_at,
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
        assert_receipt_accounts(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.receipt_token_program,
        )?;

        sync_entries_to_principal(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.owner_principal,
            &ctx.accounts.owner_entry,
            &ctx.accounts.receipt_token_program,
            &ctx.accounts.owner,
        )?;
        ctx.accounts.player.last_entry_epoch_id = ctx.accounts.epoch.id;
        emit!(EntriesRefreshed {
            owner: ctx.accounts.owner.key(),
            epoch_id: ctx.accounts.epoch.id,
            principal_entries: ctx.accounts.owner_principal.amount,
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        assert_receipt_accounts(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.receipt_token_program,
        )?;
        assert_usdc_accounts(
            &ctx.accounts.config,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.usdc_token_program,
        )?;
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
        transfer_from_config_vault(
            &ctx.accounts.config,
            &ctx.accounts.usdc_token_program,
            &ctx.accounts.principal_vault,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.owner_usdc,
            amount,
        )?;

        emit!(WithdrawalRecorded {
            owner: ctx.accounts.owner.key(),
            amount,
        });
        Ok(())
    }

    pub fn fund_prize(ctx: Context<FundPrize>, amount: u64) -> Result<()> {
        require!(amount > 0, HexVaultError::ZeroAmount);
        assert_usdc_accounts(
            &ctx.accounts.config,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.usdc_token_program,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.usdc_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.funder_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.prize_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;
        emit!(PrizeFunded {
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
        require!(!ctx.accounts.config.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.config, &ctx.accounts.epoch)?;
        require!(starts_at < ends_at, HexVaultError::InvalidTimeWindow);
        require!(
            starts_at >= ctx.accounts.epoch.starts_at && ends_at <= ctx.accounts.epoch.ends_at,
            HexVaultError::InvalidTimeWindow
        );
        let round = &mut ctx.accounts.round;
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
        require!(!ctx.accounts.config.paused, HexVaultError::ProtocolPaused);
        require_active_open_epoch(&ctx.accounts.config, &ctx.accounts.epoch)?;
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
            .checked_sub(ctx.accounts.config.round_close_buffer_seconds)
            .ok_or(HexVaultError::ArithmeticOverflow)?;
        require!(
            timestamp >= ctx.accounts.round.starts_at && timestamp < closing_time,
            HexVaultError::RoundClosed
        );
        require!(
            stake_per_tile > 0 && stake_per_tile <= ctx.accounts.config.max_stake_per_tile,
            HexVaultError::InvalidStakeAmount
        );
        assert_receipt_accounts(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.receipt_token_program,
        )?;

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
        position.owner = ctx.accounts.owner.key();
        position.round = ctx.accounts.round.key();
        position.tiles = tiles;
        position.stake_per_tile = stake_per_tile;
        position.reward_claimed = false;
        position.bump = ctx.bumps.position;
        emit!(PositionPurchased {
            owner: ctx.accounts.owner.key(),
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.epoch.id,
            round_id: ctx.accounts.round.id,
            tiles,
            total_stake,
        });
        Ok(())
    }

    pub fn request_round_randomness(ctx: Context<RequestRoundRandomness>) -> Result<()> {
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
        request.kind = REQUEST_ROUND;
        request.status = REQUEST_PENDING;
        request.subject = ctx.accounts.round.key();
        request.epoch_id = ctx.accounts.round.epoch_id;
        request.round_id = ctx.accounts.round.id;
        request.bump = ctx.bumps.request;
        emit!(RoundRandomnessRequested {
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
            round: ctx.accounts.round.key(),
            epoch_id: ctx.accounts.round.epoch_id,
            round_id: ctx.accounts.round.id,
            winning_tile: tile,
        });
        Ok(())
    }

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

        assert_receipt_accounts(
            &ctx.accounts.config,
            &ctx.accounts.principal_mint,
            &ctx.accounts.entry_mint,
            &ctx.accounts.receipt_token_program,
        )?;
        ctx.accounts.position.reward_claimed = true;
        if reward > 0 {
            mint_receipt(
                &ctx.accounts.config,
                &ctx.accounts.receipt_token_program,
                &ctx.accounts.entry_mint,
                &ctx.accounts.owner_entry,
                reward,
            )?;
        }
        emit!(RoundRewardClaimed {
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
        require!(!ctx.accounts.config.paused, HexVaultError::ProtocolPaused);
        require_keys_eq!(
            ctx.accounts.snapshot_authority.key(),
            ctx.accounts.config.snapshot_authority,
            HexVaultError::UnauthorizedSnapshotAuthority
        );
        require_active_open_epoch(&ctx.accounts.config, &ctx.accounts.epoch)?;
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
            epoch_id: epoch.id,
            prize_amount,
            total_entry_weight,
            root,
        });
        Ok(())
    }

    pub fn request_prize_randomness(ctx: Context<RequestPrizeRandomness>) -> Result<()> {
        require!(
            ctx.accounts.epoch.status == EPOCH_SNAPSHOT_COMMITTED,
            HexVaultError::InvalidEpochState
        );
        let request = &mut ctx.accounts.request;
        request.kind = REQUEST_PRIZE;
        request.status = REQUEST_PENDING;
        request.subject = ctx.accounts.epoch.key();
        request.epoch_id = ctx.accounts.epoch.id;
        request.round_id = 0;
        request.bump = ctx.bumps.request;
        ctx.accounts.epoch.status = EPOCH_RANDOMNESS_REQUESTED;
        emit!(PrizeRandomnessRequested {
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
        assert_usdc_accounts(
            &ctx.accounts.config,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.usdc_token_program,
        )?;

        let amount = ctx.accounts.epoch.prize_amount;
        transfer_from_config_vault(
            &ctx.accounts.config,
            &ctx.accounts.usdc_token_program,
            &ctx.accounts.prize_vault,
            &ctx.accounts.usdc_mint,
            &ctx.accounts.winner_usdc,
            amount,
        )?;
        ctx.accounts.epoch.status = EPOCH_PRIZE_CLAIMED;
        emit!(PrizeClaimed {
            epoch_id: ctx.accounts.epoch.id,
            winner: ctx.accounts.winner.key(),
            amount,
        });
        Ok(())
    }

    pub fn expire_unclaimed_prize(ctx: Context<ExpireUnclaimedPrize>) -> Result<()> {
        require!(
            ctx.accounts.epoch.status == EPOCH_PRIZE_DRAWN,
            HexVaultError::PrizeAlreadyResolved
        );
        require!(
            now()? >= ctx.accounts.epoch.claim_deadline,
            HexVaultError::PrizeClaimStillOpen
        );
        ctx.accounts.epoch.status = EPOCH_PRIZE_EXPIRED;
        Ok(())
    }
}

fn initialize_epoch(epoch: &mut Account<Epoch>, timing: EpochTiming, bump: u8) {
    epoch.id = timing.id;
    epoch.starts_at = timing.starts_at;
    epoch.ends_at = timing.ends_at;
    epoch.prize_snapshot_at = timing.prize_snapshot_at;
    epoch.claim_deadline = timing.claim_deadline;
    epoch.status = EPOCH_OPEN;
    epoch.prize_snapshot_root = [0; 32];
    epoch.total_entry_weight = 0;
    epoch.prize_amount = 0;
    epoch.prize_target = 0;
    epoch.bump = bump;
}

fn create_non_transferable_mint<'info>(
    payer: &Signer<'info>,
    mint: &Signer<'info>,
    mint_authority: &Account<'info, ProtocolConfig>,
    receipt_token_program: &Interface<'info, TokenInterface>,
    system_program: &Program<'info, System>,
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
        &receipt_token_program.key(),
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
        USDC_DECIMALS,
        &mint_authority.key(),
        None,
    )
}

fn assert_receipt_accounts(
    config: &ProtocolConfig,
    principal_mint: &InterfaceAccount<Mint>,
    entry_mint: &InterfaceAccount<Mint>,
    receipt_token_program: &Interface<TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        principal_mint.key(),
        config.principal_mint,
        HexVaultError::ReceiptConfigurationMismatch
    );
    require_keys_eq!(
        entry_mint.key(),
        config.entry_mint,
        HexVaultError::ReceiptConfigurationMismatch
    );
    require_keys_eq!(
        receipt_token_program.key(),
        config.receipt_token_program,
        HexVaultError::ReceiptConfigurationMismatch
    );
    Ok(())
}

fn assert_usdc_accounts(
    config: &ProtocolConfig,
    usdc_mint: &InterfaceAccount<Mint>,
    usdc_token_program: &Interface<TokenInterface>,
) -> Result<()> {
    require_keys_eq!(
        usdc_mint.key(),
        config.usdc_mint,
        HexVaultError::UsdcConfigurationMismatch
    );
    require_keys_eq!(
        usdc_token_program.key(),
        config.usdc_token_program,
        HexVaultError::UsdcConfigurationMismatch
    );
    require!(
        usdc_mint.decimals == USDC_DECIMALS,
        HexVaultError::UsdcConfigurationMismatch
    );
    Ok(())
}

fn mint_receipt<'info>(
    config: &Account<'info, ProtocolConfig>,
    receipt_token_program: &Interface<'info, TokenInterface>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    destination: &Box<InterfaceAccount<'info, TokenAccount>>,
    amount: u64,
) -> Result<()> {
    let bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[b"config".as_ref(), &bump];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            receipt_token_program.key(),
            MintTo {
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
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

fn transfer_from_config_vault<'info>(
    config: &Account<'info, ProtocolConfig>,
    usdc_token_program: &Interface<'info, TokenInterface>,
    source: &Box<InterfaceAccount<'info, TokenAccount>>,
    mint: &Box<InterfaceAccount<'info, Mint>>,
    destination: &Box<InterfaceAccount<'info, TokenAccount>>,
    amount: u64,
) -> Result<()> {
    let bump = [config.bump];
    let signer_seeds: &[&[u8]] = &[b"config".as_ref(), &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            usdc_token_program.key(),
            TransferChecked {
                from: source.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: config.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn sync_entries_to_principal<'info>(
    config: &Account<'info, ProtocolConfig>,
    principal_mint: &Box<InterfaceAccount<'info, Mint>>,
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
            config,
            receipt_token_program,
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
        // Keep this argument in the API to ensure callers always provide the
        // matching configured principal mint account for the sync transition.
        require!(
            principal_mint.key() == config.principal_mint,
            HexVaultError::ReceiptConfigurationMismatch
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, seeds = [b"config".as_ref()], bump, space = 8 + ProtocolConfig::INIT_SPACE)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = token::ID)]
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(address = token_2022::ID)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub principal_mint: Signer<'info>,
    #[account(mut)]
    pub entry_mint: Signer<'info>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = usdc_token_program
    )]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = config,
        associated_token::token_program = usdc_token_program
    )]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
}

#[derive(Accounts)]
#[instruction(timing: EpochTiming)]
pub struct CreateFirstEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(init, payer = authority, seeds = [b"epoch".as_ref(), &timing.id.to_le_bytes()], bump, space = 8 + Epoch::INIT_SPACE)]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(timing: EpochTiming)]
pub struct BeginNextEpoch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"epoch".as_ref(), &prior_epoch.id.to_le_bytes()], bump = prior_epoch.bump)]
    pub prior_epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = authority, seeds = [b"epoch".as_ref(), &timing.id.to_le_bytes()], bump, space = 8 + Epoch::INIT_SPACE)]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init_if_needed, payer = owner, seeds = [b"player".as_ref(), owner.key().as_ref()], bump, space = 8 + Player::INIT_SPACE)]
    pub player: Box<Account<'info, Player>>,
    #[account(address = config.usdc_mint @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner, token::token_program = usdc_token_program)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.principal_vault @ HexVaultError::UsdcConfigurationMismatch, token::mint = usdc_mint, token::authority = config, token::token_program = usdc_token_program)]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_token_program @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(address = config.receipt_token_program @ HexVaultError::ReceiptConfigurationMismatch)]
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
    #[account(seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"player".as_ref(), owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(address = config.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.receipt_token_program @ HexVaultError::ReceiptConfigurationMismatch)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(address = config.usdc_mint @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner, token::token_program = usdc_token_program)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.principal_vault @ HexVaultError::UsdcConfigurationMismatch, token::mint = usdc_mint, token::authority = config, token::token_program = usdc_token_program)]
    pub principal_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = principal_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_principal: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_token_program @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_token_program: Interface<'info, TokenInterface>,
    #[account(address = config.receipt_token_program @ HexVaultError::ReceiptConfigurationMismatch)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct FundPrize<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(address = config.usdc_mint @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = funder, token::token_program = usdc_token_program)]
    pub funder_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.prize_vault @ HexVaultError::UsdcConfigurationMismatch, token::mint = usdc_mint, token::authority = config, token::token_program = usdc_token_program)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_token_program @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = authority, seeds = [b"round".as_ref(), epoch.key().as_ref(), &round_id.to_le_bytes()], bump, space = 8 + Round::INIT_SPACE)]
    pub round: Box<Account<'info, Round>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"player".as_ref(), owner.key().as_ref()], bump = player.bump)]
    pub player: Box<Account<'info, Player>>,
    #[account(mut, seeds = [b"round".as_ref(), epoch.key().as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = owner, seeds = [b"position".as_ref(), round.key().as_ref(), owner.key().as_ref()], bump, space = 8 + Position::INIT_SPACE)]
    pub position: Box<Account<'info, Position>>,
    #[account(address = config.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.receipt_token_program @ HexVaultError::ReceiptConfigurationMismatch)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRoundRandomness<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut, seeds = [b"round".as_ref(), round.epoch.as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = requester, seeds = [b"randomness".as_ref(), round.key().as_ref()], bump, space = 8 + RandomnessRequest::INIT_SPACE)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillRoundWithMock<'info> {
    pub mock_randomness_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"round".as_ref(), round.epoch.as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"randomness".as_ref(), round.key().as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
}

#[derive(Accounts)]
pub struct ClaimRoundReward<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [b"round".as_ref(), round.epoch.as_ref(), &round.id.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"position".as_ref(), round.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(address = config.principal_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub principal_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.entry_mint @ HexVaultError::ReceiptConfigurationMismatch)]
    pub entry_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = entry_mint, associated_token::authority = owner, associated_token::token_program = receipt_token_program)]
    pub owner_entry: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.receipt_token_program @ HexVaultError::ReceiptConfigurationMismatch)]
    pub receipt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CommitPrizeSnapshot<'info> {
    pub snapshot_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, address = config.prize_vault @ HexVaultError::UsdcConfigurationMismatch)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct RequestPrizeRandomness<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(mut, seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = requester, seeds = [b"randomness".as_ref(), epoch.key().as_ref()], bump, space = 8 + RandomnessRequest::INIT_SPACE)]
    pub request: Box<Account<'info, RandomnessRequest>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillPrizeWithMock<'info> {
    pub mock_randomness_authority: Signer<'info>,
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [b"randomness".as_ref(), epoch.key().as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, RandomnessRequest>>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(seeds = [b"config".as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: Merkle proof verifies this recipient's public key; no signature is required for relayed claims.
    pub winner: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = winner, token::token_program = usdc_token_program)]
    pub winner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.prize_vault @ HexVaultError::UsdcConfigurationMismatch, token::mint = usdc_mint, token::authority = config, token::token_program = usdc_token_program)]
    pub prize_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_token_program @ HexVaultError::UsdcConfigurationMismatch)]
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExpireUnclaimedPrize<'info> {
    #[account(mut, seeds = [b"epoch".as_ref(), &epoch.id.to_le_bytes()], bump = epoch.bump)]
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
}
