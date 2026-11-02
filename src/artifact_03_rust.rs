use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PntNctR111111111111111111111111111111111111");

pub const MAX_LEADERBOARD_ENTRIES: usize = 10;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[program]
pub mod panta_nectar_competition {
    use super::*;

    /// Initializes a new Panta x NectarFi competition epoch.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_ts: i64,
        end_ts: i64,
        entry_fee: u64,
        min_trade_volume: u64,
        reward_split_bps: [u16; 3], // e.g. [5000, 3000, 2000] for 50%, 30%, 20%
    ) -> Result<()> {
        require!(start_ts < end_ts, CompetitionError::InvalidTimestamps);
        require!(
            (reward_split_bps[0] + reward_split_bps[1] + reward_split_bps[2]) as u64
                == BPS_DENOMINATOR,
            CompetitionError::InvalidRewardSplit
        );

        let competition = &mut ctx.accounts.competition;
        competition.authority = ctx.accounts.authority.key();
        competition.competition_id = competition_id;
        competition.mint = ctx.accounts.reward_mint.key();
        competition.vault = ctx.accounts.vault.key();
        competition.nectar_vault = ctx.accounts.nectar_vault.key();
        competition.start_ts = start_ts;
        competition.end_ts = end_ts;
        competition.entry_fee = entry_fee;
        competition.min_trade_volume = min_trade_volume;
        competition.reward_split_bps = reward_split_bps;
        competition.total_participants = 0;
        competition.total_prize_pool = 0;
        competition.accrued_nectar_yield = 0;
        competition.is_finalized = false;
        competition.bump = ctx.bumps.competition;
        competition.vault_bump = ctx.bumps.vault;

        emit!(CompetitionInitialized {
            competition_id,
            start_ts,
            end_ts,
            entry_fee,
        });

        Ok(())
    }

    /// Deposits base sponsor rewards into the vault.
    pub fn fund_prize_pool(ctx: Context<FundPrizePool>, amount: u64) -> Result<()> {
        require!(amount > 0, CompetitionError::InvalidDepositAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.sponsor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        let competition = &mut ctx.accounts.competition;
        competition.total_prize_pool = competition
            .total_prize_pool
            .checked_add(amount)
            .ok_or(CompetitionError::MathOverflow)?;

        emit!(PrizePoolFunded {
            competition_id: competition.competition_id,
            funder: ctx.accounts.sponsor.key(),
            amount,
            new_total: competition.total_prize_pool,
        });

        Ok(())
    }

    /// Participant registration. Entry fees are transferred into the competition vault.
    pub fn register_participant(ctx: Context<RegisterParticipant>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(
            clock.unix_timestamp < competition.start_ts,
            CompetitionError::RegistrationClosed
        );

        if competition.entry_fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token::transfer(cpi_ctx, competition.entry_fee)?;

            competition.total_prize_pool = competition
                .total_prize_pool
                .checked_add(competition.entry_fee)
                .ok_or(CompetitionError::MathOverflow)?;
        }

        competition.total_participants = competition
            .total_participants
            .checked_add(1)
            .ok_or(CompetitionError::MathOverflow)?;

        let participant = &mut ctx.accounts.participant;
        participant.competition = competition.key();
        participant.user = ctx.accounts.user.key();
        participant.realized_pnl = 0;
        participant.total_volume = 0;
        participant.trade_count = 0;
        participant.claimed_reward = false;
        participant.bump = ctx.bumps.participant;

        emit!(ParticipantRegistered {
            competition_id: competition.competition_id,
            user: ctx.accounts.user.key(),
            total_participants: competition.total_participants,
        });

        Ok(())
    }

    /// Record a verified trade from Panta routing. Can only be invoked by an authorized Panta relayer/CPI.
    pub fn log_trade(
        ctx: Context<LogTrade>,
        volume: u64,
        pnl_delta: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &ctx.accounts.competition;

        require!(
            clock.unix_timestamp >= competition.start_ts
                && clock.unix_timestamp <= competition.end_ts,
            CompetitionError::CompetitionInactive
        );
        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);

        let participant = &mut ctx.accounts.participant;
        participant.total_volume = participant
            .total_volume
            .checked_add(volume)
            .ok_or(CompetitionError::MathOverflow)?;
        participant.realized_pnl = participant
            .realized_pnl
            .checked_add(pnl_delta)
            .ok_or(CompetitionError::MathOverflow)?;
        participant.trade_count = participant
            .trade_count
            .checked_add(1)
            .ok_or(CompetitionError::MathOverflow)?;

        // Update leaderboard state
        let leaderboard = &mut ctx.accounts.leaderboard;
        leaderboard.update_rank(
            participant.user,
            participant.realized_pnl,
            participant.total_volume,
        );

        emit!(TradeRecorded {
            competition_id: competition.competition_id,
            user: participant.user,
            volume,
            pnl_delta,
            cumulative_pnl: participant.realized_pnl,
            cumulative_volume: participant.total_volume,
        });

        Ok(())
    }

    /// Simulates/receives harvested yield from NectarFi Vault to top up the competition prize pool.
    pub fn sync_nectar_yield(ctx: Context<SyncNectarYield>, yield_amount: u64) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);

        // Move yield token from nectar pool account to competition vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.nectar_pool_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.nectar_authority.to_account_info(),
        };
        let cpi_ctx =
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, yield_amount)?;

        competition.accrued_nectar_yield = competition
            .accrued_nectar_yield
            .checked_add(yield_amount)
            .ok_or(CompetitionError::MathOverflow)?;
        competition.total_prize_pool = competition
            .total_prize_pool
            .checked_add(yield_amount)
            .ok_or(CompetitionError::MathOverflow)?;

        emit!(YieldHarvested {
            competition_id: competition.competition_id,
            yield_amount,
            total_prize_pool: competition.total_prize_pool,
        });

        Ok(())
    }

    /// Finalizes the competition once the end timestamp has passed.
    pub fn finalize_competition(ctx: Context<FinalizeCompetition>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(
            clock.unix_timestamp > competition.end_ts,
            CompetitionError::CompetitionStillRunning
        );
        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);

        competition.is_finalized = true;

        emit!(CompetitionFinalized {
            competition_id: competition.competition_id,
            total_prize_pool: competition.total_prize_pool,
            finalized_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim rewards for 1st, 2nd, or 3rd place based on immutable leaderboard state.
    pub fn claim_prize(ctx: Context<ClaimPrize>, rank: u8) -> Result<()> {
        let competition = &ctx.accounts.competition;
        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);
        require!(rank < 3, CompetitionError::InvalidRank);

        let leaderboard = &ctx.accounts.leaderboard;
        let entry = leaderboard.entries[rank as usize];
        require!(
            entry.user == ctx.accounts.user.key(),
            CompetitionError::UserNotEligibleForRank
        );
        require!(entry.volume >= competition.min_trade_volume, CompetitionError::VolumeThresholdNotMet);

        let participant = &mut ctx.accounts.participant;
        require!(!participant.claimed_reward, CompetitionError::RewardAlreadyClaimed);

        let payout_bps = competition.reward_split_bps[rank as usize] as u64;
        let payout_amount = competition
            .total_prize_pool
            .checked_mul(payout_bps)
            .ok_or(CompetitionError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(CompetitionError::MathOverflow)?;

        participant.claimed_reward = true;

        let comp_id_bytes = competition.competition_id.to_le_bytes();
        let seeds = &[
            b"competition",
            comp_id_bytes.as_ref(),
            &[competition.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.competition.to_account_info(),
        };
        let cpi_ctx =
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
        token::transfer(cpi_ctx, payout_amount)?;

        emit!(PrizeClaimed {
            competition_id: competition.competition_id,
            user: ctx.accounts.user.key(),
            rank,
            payout_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// State Structures
// -----------------------------------------------------------------------------

#[account]
pub struct CompetitionState {
    pub authority: Pubkey,
    pub competition_id: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub nectar_vault: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub entry_fee: u64,
    pub min_trade_volume: u64,
    pub reward_split_bps: [u16; 3],
    pub total_participants: u64,
    pub total_prize_pool: u64,
    pub accrued_nectar_yield: u64,
    pub is_finalized: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl CompetitionState {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + (3 * 2) + 8 + 8 + 8 + 1 + 1 + 1 + 64;
}

#[account]
pub struct ParticipantState {
    pub competition: Pubkey,
    pub user: Pubkey,
    pub realized_pnl: i64,
    pub total_volume: u64,
    pub trade_count: u64,
    pub claimed_reward: bool,
    pub bump: u8,
}

impl ParticipantState {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct LeaderboardEntry {
    pub user: Pubkey,
    pub pnl: i64,
    pub volume: u64,
    pub score: i128,
}

#[account]
pub struct LeaderboardState {
    pub competition: Pubkey,
    pub entries: [LeaderboardEntry; MAX_LEADERBOARD_ENTRIES],
    pub bump: u8,
}

impl LeaderboardState {
    pub const LEN: usize = 8 + 32 + (MAX_LEADERBOARD_ENTRIES * (32 + 8 + 8 + 16)) + 1 + 32;

    pub fn calculate_score(pnl: i64, volume: u64) -> i128 {
        if pnl <= 0 {
            return pnl as i128;
        }
        // Approximate integer-based scaling score = PnL * ln(1 + volume)
        // Scaled by 1000 for precision
        let approx_ln = Self::approx_natural_log(volume);
        (pnl as i128).saturating_mul(approx_ln as i128)
    }

    fn approx_natural_log(val: u64) -> u64 {
        if val == 0 {
            return 1;
        }
        // Bit length approximation of log2 multiplied by ~0.693
        let bits = 64 - val.leading_zeros();
        (bits as u64).saturating_mul(693).max(100)
    }

    pub fn update_rank(&mut self, user: Pubkey, pnl: i64, volume: u64) {
        let score = Self::calculate_score(pnl, volume);
        let mut found_idx: Option<usize> = None;

        for i in 0..MAX_LEADERBOARD_ENTRIES {
            if self.entries[i].user == user {
                found_idx = Some(i);
                break;
            }
        }

        if let Some(idx) = found_idx {
            self.entries[idx].pnl = pnl;
            self.entries[idx].volume = volume;
            self.entries[idx].score = score;
        } else {
            // Find lowest score to replace
            let mut min_idx = 0;
            let mut min_score = self.entries[0].score;
            for i in 1..MAX_LEADERBOARD_ENTRIES {
                if self.entries[i].score < min_score {
                    min_score = self.entries[i].score;
                    min_idx = i;
                }
            }
            if score > min_score || self.entries[min_idx].user == Pubkey::default() {
                self.entries[min_idx] = LeaderboardEntry {
                    user,
                    pnl,
                    volume,
                    score,
                };
            }
        }

        // Sort descending by score
        self.entries.sort_by(|a, b| b.score.cmp(&a.score));
    }
}

// -----------------------------------------------------------------------------
// Instructions Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = authority,
        space = CompetitionState::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = authority,
        space = LeaderboardState::LEN,
        seeds = [b"leaderboard", competition.key().as_ref()],
        bump
    )]
    pub leaderboard: Account<'info, LeaderboardState>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", competition.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = competition,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: NectarFi Vault PDA address verified in configuration
    pub nectar_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundPrizePool<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RegisterParticipant<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = user,
        space = ParticipantState::LEN,
        seeds = [b"participant", competition.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LogTrade<'info> {
    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), participant.user.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(
        mut,
        seeds = [b"leaderboard", competition.key().as_ref()],
        bump = leaderboard.bump
    )]
    pub leaderboard: Account<'info, LeaderboardState>,

    /// CHECK: Relayer authorized as authority or Panta router
    #[account(
        constraint = relayer.key() == competition.authority @ CompetitionError::UnauthorizedRelayer
    )]
    pub relayer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SyncNectarYield<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub nectar_pool_token_account: Account<'info, TokenAccount>,

    pub nectar_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,
    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        seeds = [b"leaderboard", competition.key().as_ref()],
        bump = leaderboard.bump
    )]
    pub leaderboard: Account<'info, LeaderboardState>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), user.key().as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct CompetitionInitialized {
    pub competition_id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub entry_fee: u64,
}

#[event]
pub struct PrizePoolFunded {
    pub competition_id: u64,
    pub funder: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct ParticipantRegistered {
    pub competition_id: u64,
    pub user: Pubkey,
    pub total_participants: u64,
}

#[event]
pub struct TradeRecorded {
    pub competition_id: u64,
    pub user: Pubkey,
    pub volume: u64,
    pub pnl_delta: i64,
    pub cumulative_pnl: i64,
    pub cumulative_volume: u64,
}

#[event]
pub struct YieldHarvested {
    pub competition_id: u64,
    pub yield_amount: u64,
    pub total_prize_pool: u64,
}

#[event]
pub struct CompetitionFinalized {
    pub competition_id: u64,
    pub total_prize_pool: u64,
    pub finalized_at: i64,
}

#[event]
pub struct PrizeClaimed {
    pub competition_id: u64,
    pub user: Pubkey,
    pub rank: u8,
    pub payout_amount: u64,
}

#[error_code]
pub enum CompetitionError {
    #[msg("Invalid timestamps: start_ts must be before end_ts")]
    InvalidTimestamps,
    #[msg("Reward split bps must total 10000 (100%)")]
    InvalidRewardSplit,
    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount,
    #[msg("Registration is closed for this competition")]
    RegistrationClosed,
    #[msg("Competition is currently inactive or epoch expired")]
    CompetitionInactive,
    #[msg("Competition has already been finalized")]
    CompetitionAlreadyFinalized,
    #[msg("Competition is still running")]
    CompetitionStillRunning,
    #[msg("Competition is not yet finalized")]
    CompetitionNotFinalized,
    #[msg("Caller is not authorized to log trades")]
    UnauthorizedRelayer,
    #[msg("Invalid leaderboard rank queried")]
    InvalidRank,
    #[msg("User is not eligible for the requested rank prize")]
    UserNotEligibleForRank,
    #[msg("Minimum volume threshold not met for prize eligibility")]
    VolumeThresholdNotMet,
    #[msg("Prize has already been claimed")]
    RewardAlreadyClaimed,
    #[msg("Arithmetic overflow occurred")]
    MathOverflow,
}