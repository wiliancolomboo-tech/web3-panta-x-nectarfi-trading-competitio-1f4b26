use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PNTAnECTAR1111111111111111111111111111111111");

pub const BPS_DIVISOR: u64 = 10_000;
pub const MAX_TIER_WINNERS: usize = 10;

#[program]
pub mod panta_nectar_arena {
    use super::*;

    /// Initialize a new competition with designated prize pool and scoring rules
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_time: i64,
        end_time: i64,
        scoring_metric: u8, // 0 = Volume, 1 = RealizedPnL, 2 = HybridScore
        min_trade_size: u64,
        tier_payout_bps: [u16; MAX_TIER_WINNERS],
        initial_prize_amount: u64,
    ) -> Result<()> {
        require!(start_time < end_time, ArenaError::InvalidTimeWindow);
        let clock = Clock::get()?;
        require!(end_time > clock.unix_timestamp, ArenaError::CompetitionInPast);

        // Validate BPS sum for prize tiers equals 10000 (100.00%)
        let total_bps: u16 = tier_payout_bps.iter().sum();
        require!(total_bps == 10_000, ArenaError::InvalidPayoutDistribution);

        let competition = &mut ctx.accounts.competition;
        competition.authority = ctx.accounts.authority.key();
        competition.competition_id = competition_id;
        competition.oracle_authority = ctx.accounts.oracle_authority.key();
        competition.prize_mint = ctx.accounts.prize_mint.key();
        competition.prize_vault = ctx.accounts.prize_vault.key();
        competition.start_time = start_time;
        competition.end_time = end_time;
        competition.scoring_metric = scoring_metric;
        competition.min_trade_size = min_trade_size;
        competition.tier_payout_bps = tier_payout_bps;
        competition.total_prize_pool = initial_prize_amount;
        competition.participant_count = 0;
        competition.is_finalized = false;
        competition.is_paused = false;
        competition.bump = ctx.bumps.competition;
        competition.vault_bump = ctx.bumps.prize_vault;

        if initial_prize_amount > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.authority_token_account.to_account_info(),
                to: ctx.accounts.prize_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_ctx, initial_prize_amount)?;
        }

        emit!(CompetitionCreated {
            competition_id,
            authority: competition.authority,
            prize_mint: competition.prize_mint,
            start_time,
            end_time,
            total_prize_pool: initial_prize_amount,
        });

        Ok(())
    }

    /// Register a participant prior to or during trade settlement
    pub fn register_participant(ctx: Context<RegisterParticipant>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;
        require!(!competition.is_paused, ArenaError::CompetitionPaused);
        require!(clock.unix_timestamp < competition.end_time, ArenaError::CompetitionEnded);

        let participant = &mut ctx.accounts.participant;
        participant.trader = ctx.accounts.trader.key();
        participant.competition = competition.key();
        participant.cumulative_volume = 0;
        participant.realized_pnl = 0;
        participant.weighted_score = 0;
        participant.trade_count = 0;
        participant.last_trade_slot = clock.slot;
        participant.is_disqualified = false;
        participant.prize_claimed = false;
        participant.assigned_rank = 0;
        participant.bump = ctx.bumps.participant;

        competition.participant_count = competition
            .participant_count
            .checked_add(1)
            .ok_or(ArenaError::MathOverflow)?;

        emit!(ParticipantRegistered {
            competition_id: competition.competition_id,
            trader: participant.trader,
            slot: clock.slot,
        });

        Ok(())
    }

    /// Record a trade attestation directly by verified oracle or authorized router
    pub fn record_trade(
        ctx: Context<RecordTrade>,
        volume_usd: u64,
        realized_pnl_usd: i64,
        is_panta_routing: bool,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &ctx.accounts.competition;

        require!(!competition.is_paused, ArenaError::CompetitionPaused);
        require!(clock.unix_timestamp >= competition.start_time, ArenaError::CompetitionNotStarted);
        require!(clock.unix_timestamp <= competition.end_time, ArenaError::CompetitionEnded);
        require!(volume_usd >= competition.min_trade_size, ArenaError::TradeBelowMinSize);

        let participant = &mut ctx.accounts.participant;
        require!(!participant.is_disqualified, ArenaError::ParticipantDisqualified);

        // Anti-wash trading rule: rate limiting within single slot
        if participant.last_trade_slot == clock.slot {
            participant.flagged_suspicious_txs = participant
                .flagged_suspicious_txs
                .checked_add(1)
                .ok_or(ArenaError::MathOverflow)?;
            if participant.flagged_suspicious_txs > 15 {
                participant.is_disqualified = true;
                emit!(ParticipantDisqualifiedEvent {
                    competition_id: competition.competition_id,
                    trader: participant.trader,
                    reason: "Wash-trade rate limit breached".to_string(),
                });
                return Ok(());
            }
        }

        // Apply 10% bonus weighting for trades routed through Panta Engine
        let multiplier: u64 = if is_panta_routing { 11_000 } else { 10_000 };

        participant.cumulative_volume = participant
            .cumulative_volume
            .checked_add(volume_usd)
            .ok_or(ArenaError::MathOverflow)?;

        participant.realized_pnl = participant
            .realized_pnl
            .checked_add(realized_pnl_usd)
            .ok_or(ArenaError::MathOverflow)?;

        participant.trade_count = participant
            .trade_count
            .checked_add(1)
            .ok_or(ArenaError::MathOverflow)?;

        participant.last_trade_slot = clock.slot;

        // Calculate weighted score based on metric mode
        // 0: Volume only | 1: PnL only | 2: Hybrid (Volume + PnL)
        let delta_score: u64 = match competition.scoring_metric {
            0 => (volume_usd as u128)
                .checked_mul(multiplier as u128)
                .ok_or(ArenaError::MathOverflow)?
                .checked_div(BPS_DIVISOR as u128)
                .ok_or(ArenaError::MathOverflow)? as u64,
            1 => {
                if realized_pnl_usd > 0 {
                    (realized_pnl_usd as u128)
                        .checked_mul(multiplier as u128)
                        .ok_or(ArenaError::MathOverflow)?
                        .checked_div(BPS_DIVISOR as u128)
                        .ok_or(ArenaError::MathOverflow)? as u64
                } else {
                    0
                }
            }
            _ => {
                let pnl_component = if realized_pnl_usd > 0 { realized_pnl_usd as u64 } else { 0 };
                let combined = volume_usd.checked_add(pnl_component.checked_mul(2).unwrap_or(0)).unwrap_or(volume_usd);
                (combined as u128)
                    .checked_mul(multiplier as u128)
                    .ok_or(ArenaError::MathOverflow)?
                    .checked_div(BPS_DIVISOR as u128)
                    .ok_or(ArenaError::MathOverflow)? as u64
            }
        };

        participant.weighted_score = participant
            .weighted_score
            .checked_add(delta_score)
            .ok_or(ArenaError::MathOverflow)?;

        emit!(TradeRecorded {
            competition_id: competition.competition_id,
            trader: participant.trader,
            volume_usd,
            realized_pnl_usd,
            new_weighted_score: participant.weighted_score,
            is_panta_routing,
        });

        Ok(())
    }

    /// Admin / Oracle finalization of competition rankings
    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        top_ranked_traders: Vec<Pubkey>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;
        require!(clock.unix_timestamp >= competition.end_time, ArenaError::CompetitionStillActive);
        require!(!competition.is_finalized, ArenaError::CompetitionAlreadyFinalized);
        require!(top_ranked_traders.len() <= MAX_TIER_WINNERS, ArenaError::TooManyWinners);

        competition.is_finalized = true;

        emit!(CompetitionFinalized {
            competition_id: competition.competition_id,
            total_participants: competition.participant_count,
            winners_count: top_ranked_traders.len() as u8,
        });

        Ok(())
    }

    /// Assign verified rank to participant account post-finalization
    pub fn set_participant_rank(
        ctx: Context<SetParticipantRank>,
        assigned_rank: u8,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        require!(competition.is_finalized, ArenaError::CompetitionNotFinalized);
        require!(assigned_rank >= 1 && assigned_rank <= (MAX_TIER_WINNERS as u8), ArenaError::InvalidRank);

        let participant = &mut ctx.accounts.participant;
        require!(!participant.is_disqualified, ArenaError::ParticipantDisqualified);
        participant.assigned_rank = assigned_rank;

        emit!(RankAssigned {
            competition_id: competition.competition_id,
            trader: participant.trader,
            rank: assigned_rank,
        });

        Ok(())
    }

    /// Non-custodial claim of prize funds based on verified tier payout percentage
    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let participant = &mut ctx.accounts.participant;

        require!(competition.is_finalized, ArenaError::CompetitionNotFinalized);
        require!(!participant.is_disqualified, ArenaError::ParticipantDisqualified);
        require!(!participant.prize_claimed, ArenaError::PrizeAlreadyClaimed);
        require!(participant.assigned_rank >= 1 && participant.assigned_rank <= (MAX_TIER_WINNERS as u8), ArenaError::NotEligibleForPrize);

        let rank_idx = (participant.assigned_rank - 1) as usize;
        let payout_bps = competition.tier_payout_bps[rank_idx] as u64;
        require!(payout_bps > 0, ArenaError::NoPayoutForRank);

        let prize_amount = (competition.total_prize_pool as u128)
            .checked_mul(payout_bps as u128)
            .ok_or(ArenaError::MathOverflow)?
            .checked_div(BPS_DIVISOR as u128)
            .ok_or(ArenaError::MathOverflow)? as u64;

        participant.prize_claimed = true;

        // Sign transfer CPI using competition seeds
        let comp_id_bytes = competition.competition_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"competition",
            comp_id_bytes.as_ref(),
            &[competition.bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_vault.to_account_info(),
            to: ctx.accounts.trader_token_account.to_account_info(),
            authority: ctx.accounts.competition.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds);
        token::transfer(cpi_ctx, prize_amount)?;

        emit!(PrizeClaimed {
            competition_id: competition.competition_id,
            trader: participant.trader,
            rank: participant.assigned_rank,
            amount: prize_amount,
        });

        Ok(())
    }

    /// Emergency pause controls (multisig authority only)
    pub fn set_paused(ctx: Context<AdminControl>, pause_state: bool) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        competition.is_paused = pause_state;
        emit!(CompetitionPauseToggled {
            competition_id: competition.competition_id,
            is_paused: pause_state,
        });
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Competition::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = authority,
        seeds = [b"prize_vault", competition.key().as_ref()],
        bump,
        token::mint = prize_mint,
        token::authority = competition
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    pub prize_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = authority_token_account.mint == prize_mint.key(),
        constraint = authority_token_account.owner == authority.key()
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// CHECK: Oracle authority for trade ingestion signature checks
    pub oracle_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterParticipant<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = trader,
        space = 8 + Participant::LEN,
        seeds = [b"participant", competition.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, Participant>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordTrade<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = oracle_authority
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), participant.trader.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, Participant>,

    pub oracle_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = authority
    )]
    pub competition: Account<'info, Competition>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetParticipantRank<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = authority
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), participant.trader.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, Participant>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), trader.key().as_ref()],
        bump = participant.bump,
        has_one = trader
    )]
    pub participant: Account<'info, Participant>,

    #[account(
        mut,
        seeds = [b"prize_vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_token_account.mint == competition.prize_mint,
        constraint = trader_token_account.owner == trader.key()
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminControl<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = authority
    )]
    pub competition: Account<'info, Competition>,

    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct Competition {
    pub authority: Pubkey,
    pub oracle_authority: Pubkey,
    pub competition_id: u64,
    pub prize_mint: Pubkey,
    pub prize_vault: Pubkey,
    pub start_time: i64,
    pub end_time: i64,
    pub scoring_metric: u8,
    pub min_trade_size: u64,
    pub tier_payout_bps: [u16; MAX_TIER_WINNERS],
    pub total_prize_pool: u64,
    pub participant_count: u64,
    pub is_finalized: bool,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Competition {
    pub const LEN: usize = 32 + 32 + 8 + 32 + 32 + 8 + 8 + 1 + 8 + (2 * MAX_TIER_WINNERS) + 8 + 8 + 1 + 1 + 1 + 1 + 32;
}

#[account]
pub struct Participant {
    pub trader: Pubkey,
    pub competition: Pubkey,
    pub cumulative_volume: u64,
    pub realized_pnl: i64,
    pub weighted_score: u64,
    pub trade_count: u64,
    pub last_trade_slot: u64,
    pub flagged_suspicious_txs: u32,
    pub is_disqualified: bool,
    pub prize_claimed: bool,
    pub assigned_rank: u8,
    pub bump: u8,
}

impl Participant {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 8 + 4 + 1 + 1 + 1 + 1 + 16;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CompetitionCreated {
    pub competition_id: u64,
    pub authority: Pubkey,
    pub prize_mint: Pubkey,
    pub start_time: i64,
    pub end_time: i64,
    pub total_prize_pool: u64,
}

#[event]
pub struct ParticipantRegistered {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub slot: u64,
}

#[event]
pub struct TradeRecorded {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub volume_usd: u64,
    pub realized_pnl_usd: i64,
    pub new_weighted_score: u64,
    pub is_panta_routing: bool,
}

#[event]
pub struct CompetitionFinalized {
    pub competition_id: u64,
    pub total_participants: u64,
    pub winners_count: u8,
}

#[event]
pub struct RankAssigned {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub rank: u8,
}

#[event]
pub struct PrizeClaimed {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub rank: u8,
    pub amount: u64,
}

#[event]
pub struct ParticipantDisqualifiedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub reason: String,
}

#[event]
pub struct CompetitionPauseToggled {
    pub competition_id: u64,
    pub is_paused: bool,
}

#[error_code]
pub enum ArenaError {
    #[msg("Invalid tournament time window")]
    InvalidTimeWindow,
    #[msg("Competition end time is in the past")]
    CompetitionInPast,
    #[msg("Sum of tier payout BPS must equal 10,000 (100%)")]
    InvalidPayoutDistribution,
    #[msg("Competition has not started yet")]
    CompetitionNotStarted,
    #[msg("Competition has already ended")]
    CompetitionEnded,
    #[msg("Competition is currently paused")]
    CompetitionPaused,
    #[msg("Trade size is below minimum competition threshold")]
    TradeBelowMinSize,
    #[msg("Participant is disqualified due to wash-trading heuristics")]
    ParticipantDisqualified,
    #[msg("Competition is still active; cannot finalize")]
    CompetitionStillActive,
    #[msg("Competition has already been finalized")]
    CompetitionAlreadyFinalized,
    #[msg("Too many winner addresses provided")]
    TooManyWinners,
    #[msg("Competition has not been finalized yet")]
    CompetitionNotFinalized,
    #[msg("Rank must be between 1 and MAX_TIER_WINNERS")]
    InvalidRank,
    #[msg("Prize has already been claimed")]
    PrizeAlreadyClaimed,
    #[msg("Participant rank is not eligible for prize allocation")]
    NotEligibleForPrize,
    #[msg("Payout allocation is zero for this rank")]
    NoPayoutForRank,
    #[msg("Mathematical operation resulted in overflow")]
    MathOverflow,
}