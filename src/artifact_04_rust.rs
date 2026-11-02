use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PArtNd8zV8hZ7mNzg6a7Z4R2R2jL4s9xHqB7d1vKpUm");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_LEADERBOARD_SIZE: usize = 10;
pub const BPS_DIVISOR: u128 = 10_000;

#[program]
pub mod panta_nectar_arena {
    use super::*;

    /// Initialize a new trading competition epoch with an autonomous prize pool escrow.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_timestamp: i64,
        end_timestamp: i64,
        oracle_authority: Pubkey,
        min_trade_size: u64,
    ) -> Result<()> {
        require!(
            start_timestamp < end_timestamp,
            ArenaError::InvalidTimestampRange
        );
        require!(
            end_timestamp > Clock::get()?.unix_timestamp,
            ArenaError::CompetitionAlreadyEnded
        );

        let arena = &mut ctx.accounts.competition;
        arena.authority = ctx.accounts.authority.key();
        arena.oracle_authority = oracle_authority;
        arena.prize_mint = ctx.accounts.prize_mint.key();
        arena.prize_escrow = ctx.accounts.prize_escrow.key();
        arena.competition_id = competition_id;
        arena.start_timestamp = start_timestamp;
        arena.end_timestamp = end_timestamp;
        arena.min_trade_size = min_trade_size;
        arena.total_volume = 0;
        arena.total_competitors = 0;
        arena.is_finalized = false;
        arena.bump = ctx.bumps.competition;
        arena.escrow_bump = ctx.bumps.prize_escrow;

        emit!(CompetitionCreatedEvent {
            competition_id,
            start_timestamp,
            end_timestamp,
            oracle_authority,
            prize_mint: arena.prize_mint,
        });

        Ok(())
    }

    /// Register a competitor profile for the specified competition epoch.
    pub fn register_competitor(
        ctx: Context<RegisterCompetitor>,
        competition_id: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let arena = &mut ctx.accounts.competition;

        require!(
            clock.unix_timestamp < arena.end_timestamp,
            ArenaError::CompetitionAlreadyEnded
        );
        require!(!arena.is_finalized, ArenaError::CompetitionFinalized);

        let profile = &mut ctx.accounts.competitor_profile;
        profile.competitor = ctx.accounts.competitor.key();
        profile.competition_id = competition_id;
        profile.total_volume = 0;
        profile.realized_pnl = 0;
        profile.total_trades = 0;
        profile.score = 0;
        profile.claimed_prize = false;
        profile.final_rank = 0;
        profile.bump = ctx.bumps.competitor_profile;

        arena.total_competitors = arena
            .total_competitors
            .checked_add(1)
            .ok_or(ArenaError::MathOverflow)?;

        emit!(CompetitorRegisteredEvent {
            competition_id,
            competitor: profile.competitor,
            registered_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit funds into the competition prize pool escrow.
    pub fn fund_prize_pool(ctx: Context<FundPrizePool>, amount: u64) -> Result<()> {
        require!(amount > 0, ArenaError::ZeroDepositAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.prize_escrow.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(PrizePoolFundedEvent {
            competition_id: ctx.accounts.competition.competition_id,
            funder: ctx.accounts.funder.key(),
            amount,
        });

        Ok(())
    }

    /// Record a verified trade attestation executed on Panta DEX or NectarFi Vaults.
    /// Deduplicates trade hash to guarantee idempotent single execution.
    pub fn record_verified_trade(
        ctx: Context<RecordVerifiedTrade>,
        trade_hash: [u8; 32],
        volume_usdc: u64,
        pnl_delta: i64,
        timestamp: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let arena = &mut ctx.accounts.competition;

        require!(!arena.is_finalized, ArenaError::CompetitionFinalized);
        require!(
            timestamp >= arena.start_timestamp && timestamp <= arena.end_timestamp,
            ArenaError::TradeTimestampOutOfBounds
        );
        require!(
            volume_usdc >= arena.min_trade_size,
            ArenaError::TradeBelowMinimumThreshold
        );

        // Populate and freeze trade receipt PDA (guarantees idempotency)
        let receipt = &mut ctx.accounts.trade_receipt;
        receipt.trade_hash = trade_hash;
        receipt.competitor = ctx.accounts.competitor_profile.competitor;
        receipt.volume = volume_usdc;
        receipt.pnl_delta = pnl_delta;
        receipt.timestamp = timestamp;
        receipt.bump = ctx.bumps.trade_receipt;

        // Update competitor profile
        let profile = &mut ctx.accounts.competitor_profile;
        profile.total_volume = profile
            .total_volume
            .checked_add(volume_usdc)
            .ok_or(ArenaError::MathOverflow)?;
        profile.realized_pnl = profile
            .realized_pnl
            .checked_add(pnl_delta)
            .ok_or(ArenaError::MathOverflow)?;
        profile.total_trades = profile
            .total_trades
            .checked_add(1)
            .ok_or(ArenaError::MathOverflow)?;

        // Update overall arena volume
        arena.total_volume = arena
            .total_volume
            .checked_add(volume_usdc)
            .ok_or(ArenaError::MathOverflow)?;

        // Compute updated dynamic score
        profile.score = compute_score(profile.total_volume, profile.realized_pnl)?;

        emit!(TradeRecordedEvent {
            competition_id: arena.competition_id,
            competitor: profile.competitor,
            trade_hash,
            volume: volume_usdc,
            pnl_delta,
            updated_score: profile.score,
        });

        Ok(())
    }

    /// Oracle finalizes the epoch and binds winner ranks.
    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        ranked_winners: Vec<Pubkey>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let arena = &mut ctx.accounts.competition;

        require!(
            clock.unix_timestamp >= arena.end_timestamp,
            ArenaError::CompetitionStillActive
        );
        require!(!arena.is_finalized, ArenaError::CompetitionAlreadyFinalized);
        require!(
            ranked_winners.len() <= MAX_LEADERBOARD_SIZE,
            ArenaError::ExceedsLeaderboardCapacity
        );

        arena.is_finalized = true;

        emit!(CompetitionFinalizedEvent {
            competition_id: arena.competition_id,
            total_competitors: arena.total_competitors,
            total_volume: arena.total_volume,
            finalized_at: clock.unix_timestamp,
            winner_count: ranked_winners.len() as u32,
        });

        Ok(())
    }

    /// Winner claims their deterministic prize reward from the escrow PDA.
    pub fn claim_reward(
        ctx: Context<ClaimReward>,
        rank: u8,
        allocated_amount: u64,
    ) -> Result<()> {
        let arena = &ctx.accounts.competition;
        let profile = &mut ctx.accounts.competitor_profile;

        require!(arena.is_finalized, ArenaError::CompetitionNotFinalized);
        require!(!profile.claimed_prize, ArenaError::PrizeAlreadyClaimed);
        require!(rank > 0 && rank <= 3, ArenaError::InvalidWinnerRank);
        require!(allocated_amount > 0, ArenaError::ZeroRewardAllocation);

        profile.claimed_prize = true;
        profile.final_rank = rank;

        let comp_id_bytes = arena.competition_id.to_le_bytes();
        let seeds = &[
            b"arena_escrow",
            comp_id_bytes.as_ref(),
            &[arena.escrow_bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_escrow.to_account_info(),
            to: ctx.accounts.competitor_token_account.to_account_info(),
            authority: ctx.accounts.prize_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, allocated_amount)?;

        emit!(PrizeClaimedEvent {
            competition_id: arena.competition_id,
            competitor: profile.competitor,
            rank,
            amount: allocated_amount,
        });

        Ok(())
    }
}

/// Dynamic Score Calculation:
/// Score = Volume * (10_000 + PnL_BPS_Clamped) / 10_000
/// Discourages pure wash trading by scaling volume against actual realized PnL performance.
pub fn compute_score(total_volume: u64, realized_pnl: i64) -> Result<u128> {
    let vol_u128 = total_volume as u128;
    if vol_u128 == 0 {
        return Ok(0);
    }

    // Determine PnL BPS against volume (clamped between -50% (-5000 bps) and +100% (+10000 bps))
    let pnl_bps: i64 = if realized_pnl >= 0 {
        let raw = ((realized_pnl as u128)
            .checked_mul(BPS_DIVISOR)
            .ok_or(ArenaError::MathOverflow)?)
        .checked_div(vol_u128)
        .unwrap_or(0) as i64;
        raw.min(10_000)
    } else {
        let abs_pnl = realized_pnl.abs() as u128;
        let raw = ((abs_pnl)
            .checked_mul(BPS_DIVISOR)
            .ok_or(ArenaError::MathOverflow)?)
        .checked_div(vol_u128)
        .unwrap_or(0) as i64;
        (-raw).max(-5000)
    };

    let multiplier = (10_000i64)
        .checked_add(pnl_bps)
        .ok_or(ArenaError::MathOverflow)? as u128;

    let final_score = vol_u128
        .checked_mul(multiplier)
        .ok_or(ArenaError::MathOverflow)?
        .checked_div(BPS_DIVISOR)
        .ok_or(ArenaError::MathOverflow)?;

    Ok(final_score)
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub征
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = authority,
        space = DISCRIMINATOR_LENGTH + CompetitionState::INIT_SPACE,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, CompetitionState>,

    pub prize_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"arena_escrow", competition_id.to_le_bytes().as_ref()],
        bump,
        token::mint = prize_mint,
        token::authority = prize_escrow
    )]
    pub prize_escrow: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct RegisterCompetitor<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = competitor,
        space = DISCRIMINATOR_LENGTH + CompetitorProfile::INIT_SPACE,
        seeds = [
            b"competitor",
            competition_id.to_le_bytes().as_ref(),
            competitor.key().as_ref()
        ],
        bump
    )]
    pub competitor_profile: Account<'info, CompetitorProfile>,

    #[account(mut)]
    pub competitor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPrizePool<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"arena_escrow", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.escrow_bump
    )]
    pub prize_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token_account.mint == competition.prize_mint @ ArenaError::InvalidPrizeMint,
        constraint = funder_token_account.owner == funder.key() @ ArenaError::UnauthorizedAccountOwner
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub funder: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(trade_hash: [u8; 32])]
pub struct RecordVerifiedTrade<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = oracle_authority @ ArenaError::UnauthorizedOracle
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [
            b"competitor",
            competition.competition_id.to_le_bytes().as_ref(),
            competitor_profile.competitor.as_ref()
        ],
        bump = competitor_profile.bump
    )]
    pub competitor_profile: Account<'info, CompetitorProfile>,

    #[account(
        init,
        payer = oracle_authority,
        space = DISCRIMINATOR_LENGTH + TradeReceipt::INIT_SPACE,
        seeds = [b"receipt", trade_hash.as_ref()],
        bump
    )]
    pub trade_receipt: Account<'info, TradeReceipt>,

    #[account(mut)]
    pub oracle_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = authority @ ArenaError::UnauthorizedAuthority
    )]
    pub competition: Account<'info, CompetitionState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [
            b"competitor",
            competition.competition_id.to_le_bytes().as_ref(),
            competitor.key().as_ref()
        ],
        bump = competitor_profile.bump,
        has_one = competitor @ ArenaError::UnauthorizedCompetitor
    )]
    pub competitor_profile: Account<'info, CompetitorProfile>,

    #[account(
        mut,
        seeds = [b"arena_escrow", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.escrow_bump
    )]
    pub prize_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = competitor_token_account.mint == competition.prize_mint @ ArenaError::InvalidPrizeMint,
        constraint = competitor_token_account.owner == competitor.key() @ ArenaError::UnauthorizedAccountOwner
    )]
    pub competitor_token_account: Account<'info, TokenAccount>,

    pub competitor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct CompetitionState {
    pub authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub prize_mint: Pubkey,
    pub prize_escrow: Pubkey,
    pub competition_id: u64,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub min_trade_size: u64,
    pub total_volume: u64,
    pub total_competitors: u64,
    pub is_finalized: bool,
    pub bump: u8,
    pub escrow_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CompetitorProfile {
    pub competitor: Pubkey,
    pub competition_id: u64,
    pub total_volume: u64,
    pub realized_pnl: i64,
    pub total_trades: u64,
    pub score: u128,
    pub claimed_prize: bool,
    pub final_rank: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TradeReceipt {
    pub trade_hash: [u8; 32],
    pub competitor: Pubkey,
    pub volume: u64,
    pub pnl_delta: i64,
    pub timestamp: i64,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CompetitionCreatedEvent {
    pub competition_id: u64,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub oracle_authority: Pubkey,
    pub prize_mint: Pubkey,
}

#[event]
pub struct CompetitorRegisteredEvent {
    pub competition_id: u64,
    pub competitor: Pubkey,
    pub registered_at: i64,
}

#[event]
pub struct PrizePoolFundedEvent {
    pub competition_id: u64,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct TradeRecordedEvent {
    pub competition_id: u64,
    pub competitor: Pubkey,
    pub trade_hash: [u8; 32],
    pub volume: u64,
    pub pnl_delta: i64,
    pub updated_score: u128,
}

#[event]
pub struct CompetitionFinalizedEvent {
    pub competition_id: u64,
    pub total_competitors: u64,
    pub total_volume: u64,
    pub finalized_at: i64,
    pub winner_count: u32,
}

#[event]
pub struct PrizeClaimedEvent {
    pub competition_id: u64,
    pub competitor: Pubkey,
    pub rank: u8,
    pub amount: u64,
}

#[error_code]
pub enum ArenaError {
    #[msg("Invalid timestamp range: start_timestamp must precede end_timestamp")]
    InvalidTimestampRange,
    #[msg("Competition has already concluded")]
    CompetitionAlreadyEnded,
    #[msg("Competition has already been finalized")]
    CompetitionAlreadyFinalized,
    #[msg("Competition is not yet finalized")]
    CompetitionNotFinalized,
    #[msg("Competition has reached finalization; no further actions allowed")]
    CompetitionFinalized,
    #[msg("Competition is currently active")]
    CompetitionStillActive,
    #[msg("Arithmetic overflow detected in state transition")]
    MathOverflow,
    #[msg("Zero deposit amount is invalid")]
    ZeroDepositAmount,
    #[msg("Trade timestamp falls outside epoch boundary")]
    TradeTimestampOutOfBounds,
    #[msg("Trade size falls below the minimum required volume")]
    TradeBelowMinimumThreshold,
    #[msg("Prize has already been claimed by this competitor")]
    PrizeAlreadyClaimed,
    #[msg("Invalid winner rank specified")]
    InvalidWinnerRank,
    #[msg("Allocated reward amount cannot be zero")]
    ZeroRewardAllocation,
    #[msg("Invalid prize mint provided")]
    InvalidPrizeMint,
    #[msg("Account owner mismatch or unauthorized access")]
    UnauthorizedAccountOwner,
    #[msg("Signer does not match the configured oracle authority")]
    UnauthorizedOracle,
    #[msg("Signer does not match competition administrator authority")]
    UnauthorizedAuthority,
    #[msg("Signer does not match competitor profile")]
    UnauthorizedCompetitor,
    #[msg("Leaderboard candidate count exceeds maximum allowed vector")]
    ExceedsLeaderboardCapacity,
}