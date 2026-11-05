use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PNEcmp9999999999999999999999999999999999999");

pub const MAX_LEADERBOARD_ENTRIES: usize = 50;
pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const PUBKEY_LENGTH: usize = 32;
pub const U64_LENGTH: usize = 8;
pub const I64_LENGTH: usize = 8;
pub const BOOL_LENGTH: usize = 1;
pub const U16_LENGTH: usize = 2;

#[program]
pub mod pne_competition {
    use super::*;

    /// Initialize a new competition instance with escrow vault and rule configurations.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_time: i64,
        end_time: i64,
        min_trade_volume_threshold: u64,
        nectar_multiplier_bps: u16, // e.g., 12500 for 1.25x
        total_reward_amount: u64,
    ) -> Result<()> {
        require!(start_time < end_time, CompetitionError::InvalidEpochBounds);
        let clock = Clock::get()?;
        require!(end_time > clock.unix_timestamp, CompetitionError::EpochInPast);
        require!(nectar_multiplier_bps >= 10000, CompetitionError::InvalidMultiplier);

        let competition = &mut ctx.accounts.competition;
        competition.authority = ctx.accounts.authority.key();
        competition.oracle_signer = ctx.accounts.oracle_signer.key();
        competition.reward_mint = ctx.accounts.reward_mint.key();
        competition.prize_vault = ctx.accounts.prize_vault.key();
        competition.competition_id = competition_id;
        competition.start_time = start_time;
        competition.end_time = end_time;
        competition.min_trade_volume_threshold = min_trade_volume_threshold;
        competition.nectar_multiplier_bps = nectar_multiplier_bps;
        competition.total_reward_amount = total_reward_amount;
        competition.total_registered_traders = 0;
        competition.total_volume_tracked = 0;
        competition.is_finalized = false;
        competition.merkle_root = [0u8; 32];
        competition.bump = ctx.bumps.competition;
        competition.vault_bump = ctx.bumps.prize_vault;

        // Transfer prize pool to escrow
        let cpi_accounts = Transfer {
            from: ctx.accounts.authority_token_account.to_account_info(),
            to: ctx.accounts.prize_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, total_reward_amount)?;

        emit!(CompetitionInitializedEvent {
            competition_id,
            start_time,
            end_time,
            reward_pool: total_reward_amount,
            reward_mint: ctx.accounts.reward_mint.key(),
        });

        Ok(())
    }

    /// Register trader on-chain to participate in trackable metrics.
    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp < competition.end_time, CompetitionError::CompetitionAlreadyEnded);
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);

        let trader = &mut ctx.accounts.trader_account;
        trader.competitor = ctx.accounts.trader.key();
        trader.competition = competition.key();
        trader.cumulative_volume = 0;
        trader.realized_pnl = 0;
        trader.weighted_score = 0;
        trader.trades_count = 0;
        trader.has_nectar_boost = false;
        trader.last_updated_slot = clock.slot;
        trader.has_claimed = false;
        trader.bump = ctx.bumps.trader_account;

        competition.total_registered_traders = competition
            .total_registered_traders
            .checked_add(1)
            .ok_or(CompetitionError::NumericOverflow)?;

        emit!(TraderRegisteredEvent {
            competition_id: competition.competition_id,
            trader: ctx.accounts.trader.key(),
            registered_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Authorized off-chain indexer batch-pushes verified trades from Panta & NectarFi.
    pub fn update_trader_metrics(
        ctx: Context<UpdateTraderMetrics>,
        volume_delta: u64,
        pnl_delta: i64,
        is_nectar_lp: bool,
        sequence_id: u64,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let clock = Clock::get()?;
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);
        require!(clock.unix_timestamp >= competition.start_time, CompetitionError::CompetitionNotStarted);
        require!(clock.unix_timestamp <= competition.end_time, CompetitionError::CompetitionAlreadyEnded);

        let trader = &mut ctx.accounts.trader_account;
        require!(sequence_id > trader.last_updated_slot, CompetitionError::StaleSequenceId);

        trader.cumulative_volume = trader
            .cumulative_volume
            .checked_add(volume_delta)
            .ok_or(CompetitionError::NumericOverflow)?;

        trader.realized_pnl = trader
            .realized_pnl
            .checked_add(pnl_delta)
            .ok_or(CompetitionError::NumericOverflow)?;

        trader.trades_count = trader
            .trades_count
            .checked_add(1)
            .ok_or(CompetitionError::NumericOverflow)?;

        trader.has_nectar_boost = is_nectar_lp;
        trader.last_updated_slot = sequence_id;

        // Scoring Formula:
        // Base Score = Volume + max(0, PnL)
        // If NectarFi LP booster active: Base Score * multiplier
        let base_pnl_score = if trader.realized_pnl > 0 {
            trader.realized_pnl as u64
        } else {
            0u64
        };

        let raw_score = trader
            .cumulative_volume
            .checked_add(base_pnl_score)
            .ok_or(CompetitionError::NumericOverflow)?;

        if is_nectar_lp {
            let boosted_score = (raw_score as u128)
                .checked_mul(competition.nectar_multiplier_bps as u128)
                .ok_or(CompetitionError::NumericOverflow)?
                .checked_div(10000)
                .ok_or(CompetitionError::NumericOverflow)?;
            trader.weighted_score = boosted_score as u64;
        } else {
            trader.weighted_score = raw_score;
        }

        let comp_mut = &mut ctx.accounts.competition;
        comp_mut.total_volume_tracked = comp_mut
            .total_volume_tracked
            .checked_add(volume_delta)
            .ok_or(CompetitionError::NumericOverflow)?;

        emit!(TradeMetricsUpdatedEvent {
            competition_id: comp_mut.competition_id,
            trader: trader.competitor,
            new_volume: trader.cumulative_volume,
            new_pnl: trader.realized_pnl,
            weighted_score: trader.weighted_score,
            sequence_id,
        });

        Ok(())
    }

    /// Seal competition and publish the Merkle root of the prize allocation.
    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= competition.end_time, CompetitionError::EpochStillActive);
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);

        competition.is_finalized = true;
        competition.merkle_root = merkle_root;

        emit!(CompetitionFinalizedEvent {
            competition_id: competition.competition_id,
            merkle_root,
            finalized_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim reward with cryptographic verification against committed Merkle root.
    pub fn claim_reward(
        ctx: Context<ClaimReward>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let trader = &mut ctx.accounts.trader_account;

        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);
        require!(!trader.has_claimed, CompetitionError::RewardAlreadyClaimed);

        // Verify Leaf node: H(trader_pubkey || amount)
        let leaf = anchor_lang::solana_program::keccak::hashv(&[
            trader.competitor.as_ref(),
            &amount.to_le_bytes(),
        ]).0;

        let is_valid = verify_merkle_proof(&proof, competition.merkle_root, leaf);
        require!(is_valid, CompetitionError::InvalidMerkleProof);

        trader.has_claimed = true;

        let comp_key = competition.key();
        let seeds = &[
            b"prize_vault".as_ref(),
            comp_key.as_ref(),
            &[competition.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_vault.to_account_info(),
            to: ctx.accounts.trader_token_account.to_account_info(),
            authority: ctx.accounts.prize_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;

        emit!(RewardClaimedEvent {
            competition_id: competition.competition_id,
            trader: trader.competitor,
            reward_amount: amount,
        });

        Ok(())
    }

    /// Admin recovery in the case of unclaimed rewards 90 days after finalization.
    pub fn emergency_withdraw_unclaimed(
        ctx: Context<EmergencyWithdraw>,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let clock = Clock::get()?;
        let ninety_days = 90 * 24 * 60 * 60;
        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);
        require!(
            clock.unix_timestamp > competition.end_time.checked_add(ninety_days).unwrap(),
            CompetitionError::TimelockNotExpired
        );

        let remaining_balance = ctx.accounts.prize_vault.amount;
        let comp_key = competition.key();
        let seeds = &[
            b"prize_vault".as_ref(),
            comp_key.as_ref(),
            &[competition.vault_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_vault.to_account_info(),
            to: ctx.accounts.authority_token_account.to_account_info(),
            authority: ctx.accounts.prize_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, remaining_balance)?;

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Merkle Verifier Utility
// -----------------------------------------------------------------------------
pub fn verify_merkle_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed_hash = leaf;
    for proof_element in proof.iter() {
        if computed_hash <= *proof_element {
            computed_hash = anchor_lang::solana_program::keccak::hashv(&[
                &computed_hash,
                proof_element,
            ]).0;
        } else {
            computed_hash = anchor_lang::solana_program::keccak::hashv(&[
                proof_element,
                &computed_hash,
            ]).0;
        }
    }
    computed_hash == root
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = authority,
        space = DISCRIMINATOR_LENGTH + Competition::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = authority,
        seeds = [b"prize_vault", competition.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = prize_vault
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = authority_token_account.mint == reward_mint.key(),
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// CHECK: Oracle authority configured for trade ingestion
    pub oracle_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterTrader<'info> {
    #[account(mut)]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = trader,
        space = DISCRIMINATOR_LENGTH + TraderAccount::LEN,
        seeds = [b"trader", competition.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTraderMetrics<'info> {
    #[account(mut)]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"trader", competition.key().as_ref(), trader_account.competitor.as_ref()],
        bump = trader_account.bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(
        constraint = oracle_signer.key() == competition.oracle_signer @ CompetitionError::UnauthorizedOracle
    )]
    pub oracle_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        has_one = authority @ CompetitionError::UnauthorizedAdmin
    )]
    pub competition: Account<'info, Competition>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"prize_vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"trader", competition.key().as_ref(), claimant.key().as_ref()],
        bump = trader_account.bump,
        constraint = trader_account.competitor == claimant.key() @ CompetitionError::UnauthorizedClaimant
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(
        mut,
        constraint = trader_token_account.mint == competition.reward_mint,
        constraint = trader_token_account.owner == claimant.key()
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub claimant: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(
        mut,
        has_one = authority @ CompetitionError::UnauthorizedAdmin
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"prize_vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = authority_token_account.mint == competition.reward_mint,
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// State Structs
// -----------------------------------------------------------------------------
#[account]
pub struct Competition {
    pub authority: Pubkey,
    pub oracle_signer: Pubkey,
    pub reward_mint: Pubkey,
    pub prize_vault: Pubkey,
    pub competition_id: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub min_trade_volume_threshold: u64,
    pub nectar_multiplier_bps: u16,
    pub total_reward_amount: u64,
    pub total_registered_traders: u64,
    pub total_volume_tracked: u64,
    pub is_finalized: bool,
    pub merkle_root: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

impl Competition {
    pub const LEN: usize = PUBKEY_LENGTH * 4
        + U64_LENGTH * 5
        + I64_LENGTH * 2
        + U16_LENGTH
        + BOOL_LENGTH
        + 32
        + 1
        + 1;
}

#[account]
pub struct TraderAccount {
    pub competitor: Pubkey,
    pub competition: Pubkey,
    pub cumulative_volume: u64,
    pub realized_pnl: i64,
    pub weighted_score: u64,
    pub trades_count: u64,
    pub has_nectar_boost: bool,
    pub last_updated_slot: u64,
    pub has_claimed: bool,
    pub bump: u8,
}

impl TraderAccount {
    pub const LEN: usize = PUBKEY_LENGTH * 2
        + U64_LENGTH * 4
        + I64_LENGTH
        + BOOL_LENGTH * 2
        + 1;
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------
#[event]
pub struct CompetitionInitializedEvent {
    pub competition_id: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub reward_pool: u64,
    pub reward_mint: Pubkey,
}

#[event]
pub struct TraderRegisteredEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub registered_at: i64,
}

#[event]
pub struct TradeMetricsUpdatedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub new_volume: u64,
    pub new_pnl: i64,
    pub weighted_score: u64,
    pub sequence_id: u64,
}

#[event]
pub struct CompetitionFinalizedEvent {
    pub competition_id: u64,
    pub merkle_root: [u8; 32],
    pub finalized_at: i64,
}

#[event]
pub struct RewardClaimedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub reward_amount: u64,
}

#[error_code]
pub enum CompetitionError {
    #[msg("Epoch bounds are invalid (start_time must be strictly before end_time)")]
    InvalidEpochBounds,
    #[msg("Epoch end time must be in the future")]
    EpochInPast,
    #[msg("NectarFi multiplier basis points must be at least 10,000 (1.0x)")]
    InvalidMultiplier,
    #[msg("Numeric calculation overflow or underflow")]
    NumericOverflow,
    #[msg("Competition has already concluded")]
    CompetitionAlreadyEnded,
    #[msg("Competition is already finalized")]
    CompetitionFinalized,
    #[msg("Competition is not yet active")]
    CompetitionNotStarted,
    #[msg("Sequence slot ID is stale or out of order")]
    StaleSequenceId,
    #[msg("Competition epoch has not yet finished")]
    EpochStillActive,
    #[msg("Competition has not yet been finalized")]
    CompetitionNotFinalized,
    #[msg("Trader has already claimed the reward allocation")]
    RewardAlreadyClaimed,
    #[msg("Cryptographic Merkle proof is invalid or malformed")]
    InvalidMerkleProof,
    #[msg("Timelock has not expired for emergency funds recovery")]
    TimelockNotExpired,
    #[msg("Signer is not authorized as the registered oracle")]
    UnauthorizedOracle,
    #[msg("Signer is not the authority of this competition")]
    UnauthorizedAdmin,
    #[msg("Signer does not match the registered claimant PDA")]
    UnauthorizedClaimant,
}