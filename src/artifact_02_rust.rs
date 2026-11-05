// File: programs/panta_nectar_arena/src/lib.rs

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PntNctR111111111111111111111111111111111111");

pub const MAX_LEADERBOARD_SIZE: usize = 10;
pub const BPS_DENOMINATOR: u16 = 10000;

#[program]
pub mod panta_nectar_arena {
    use super::*;

    /// Initialize a new trading competition instance.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_ts: i64,
        end_ts: i64,
        entry_fee: u64,
        min_trade_volume: u64,
        reward_distribution_bps: [u16; 3], // e.g. [5000, 3000, 2000] for 50%, 30%, 20%
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(start_ts >= clock.unix_timestamp, ArenaError::InvalidStartTime);
        require!(end_ts > start_ts, ArenaError::InvalidEndTime);

        let total_bps: u16 = reward_distribution_bps.iter().sum();
        require!(total_bps == BPS_DENOMINATOR, ArenaError::InvalidBpsDistribution);

        let competition = &mut ctx.accounts.competition;
        competition.competition_id = competition_id;
        competition.admin = ctx.accounts.admin.key();
        competition.oracle = ctx.accounts.oracle.key();
        competition.reward_mint = ctx.accounts.reward_mint.key();
        competition.prize_vault = ctx.accounts.prize_vault.key();
        competition.start_ts = start_ts;
        competition.end_ts = end_ts;
        competition.entry_fee = entry_fee;
        competition.min_trade_volume = min_trade_volume;
        competition.reward_distribution_bps = reward_distribution_bps;
        competition.total_participants = 0;
        competition.total_volume = 0;
        competition.is_settled = false;
        competition.bump = ctx.bumps.competition;
        competition.vault_bump = ctx.bumps.prize_vault;

        emit!(CompetitionCreated {
            competition_id,
            admin: competition.admin,
            start_ts,
            end_ts,
            entry_fee,
        });

        Ok(())
    }

    /// Register trader for the competition and deposit the entry fee into the prize vault.
    pub fn register_participant(ctx: Context<RegisterParticipant>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(!competition.is_settled, ArenaError::CompetitionAlreadySettled);
        require!(clock.unix_timestamp < competition.end_ts, ArenaError::CompetitionEnded);

        if competition.entry_fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.prize_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_ctx, competition.entry_fee)?;
        }

        let participant = &mut ctx.accounts.participant;
        participant.competition = competition.key();
        participant.trader = ctx.accounts.trader.key();
        participant.volume = 0;
        participant.realized_pnl = 0;
        participant.trades_count = 0;
        participant.has_claimed = false;
        participant.final_rank = 0;
        participant.registered_at = clock.unix_timestamp;
        participant.bump = ctx.bumps.participant;

        competition.total_participants = competition.total_participants.checked_add(1).ok_or(ArenaError::MathOverflow)?;

        emit!(ParticipantRegistered {
            competition_id: competition.competition_id,
            trader: participant.trader,
            registered_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Record a verified trade from Panta routing or NectarFi strategy (authorized oracle only).
    pub fn record_trade(
        ctx: Context<RecordTrade>,
        volume: u64,
        pnl_delta: i128,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(clock.unix_timestamp >= competition.start_ts, ArenaError::CompetitionNotStarted);
        require!(clock.unix_timestamp <= competition.end_ts, ArenaError::CompetitionEnded);
        require!(!competition.is_settled, ArenaError::CompetitionAlreadySettled);

        let participant = &mut ctx.accounts.participant;
        require!(participant.competition == competition.key(), ArenaError::ParticipantMismatch);

        participant.volume = participant.volume.checked_add(volume).ok_or(ArenaError::MathOverflow)?;
        participant.realized_pnl = participant.realized_pnl.checked_add(pnl_delta).ok_or(ArenaError::MathOverflow)?;
        participant.trades_count = participant.trades_count.checked_add(1).ok_or(ArenaError::MathOverflow)?;

        competition.total_volume = competition.total_volume.checked_add(volume).ok_or(ArenaError::MathOverflow)?;

        emit!(TradeRecorded {
            competition_id: competition.competition_id,
            trader: participant.trader,
            volume_delta: volume,
            pnl_delta,
            cumulative_volume: participant.volume,
            cumulative_pnl: participant.realized_pnl,
        });

        Ok(())
    }

    /// Settle the competition and set the top 3 ranked winners (authorized oracle/admin).
    pub fn settle_competition(
        ctx: Context<SettleCompetition>,
        ranked_traders: [Pubkey; 3],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(clock.unix_timestamp > competition.end_ts, ArenaError::CompetitionStillActive);
        require!(!competition.is_settled, ArenaError::CompetitionAlreadySettled);

        competition.is_settled = true;
        competition.winner_1 = ranked_traders[0];
        competition.winner_2 = ranked_traders[1];
        competition.winner_3 = ranked_traders[2];

        let vault_balance = ctx.accounts.prize_vault.amount;
        competition.settled_prize_pool = vault_balance;

        emit!(CompetitionSettled {
            competition_id: competition.competition_id,
            prize_pool: vault_balance,
            winner_1: ranked_traders[0],
            winner_2: ranked_traders[1],
            winner_3: ranked_traders[2],
            settled_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim payout for verified rank winners.
    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let participant = &mut ctx.accounts.participant;

        require!(competition.is_settled, ArenaError::CompetitionNotSettled);
        require!(!participant.has_claimed, ArenaError::RewardAlreadyClaimed);
        require!(participant.trader == ctx.accounts.trader.key(), ArenaError::UnauthorizedClaim);

        let trader_key = ctx.accounts.trader.key();
        let rank: usize;

        if trader_key == competition.winner_1 {
            rank = 1;
        } else if trader_key == competition.winner_2 {
            rank = 2;
        } else if trader_key == competition.winner_3 {
            rank = 3;
        } else {
            return Err(ArenaError::NotAWinner.into());
        }

        let bps = competition.reward_distribution_bps[rank - 1];
        let reward_amount = (competition.settled_prize_pool as u128)
            .checked_mul(bps as u128)
            .ok_or(ArenaError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(ArenaError::MathOverflow)? as u64;

        participant.has_claimed = true;
        participant.final_rank = rank as u8;

        let competition_id_bytes = competition.competition_id.to_le_bytes();
        let seeds = &[
            b"competition".as_ref(),
            competition_id_bytes.as_ref(),
            &[competition.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_vault.to_account_info(),
            to: ctx.accounts.trader_token_account.to_account_info(),
            authority: ctx.accounts.competition.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, reward_amount)?;

        emit!(RewardClaimed {
            competition_id: competition.competition_id,
            trader: trader_key,
            rank: rank as u8,
            reward_amount,
        });

        Ok(())
    }

    /// Emergency refund logic in case of catastrophic pause prior to settlement.
    pub fn emergency_abort(ctx: Context<EmergencyAbort>) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        require!(!competition.is_settled, ArenaError::CompetitionAlreadySettled);

        competition.is_settled = true;
        emit!(CompetitionAborted {
            competition_id: competition.competition_id,
            aborted_at: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + CompetitionState::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, CompetitionState>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault", competition.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = competition,
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    /// CHECK: Authorized Keeper or Oracle pubkey
    pub oracle: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
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
        payer = trader,
        space = 8 + ParticipantState::LEN,
        seeds = [b"participant", competition.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == trader.key(),
        constraint = user_token_account.mint == competition.reward_mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecordTrade<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = oracle @ ArenaError::UnauthorizedOracle
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), participant.trader.as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, ParticipantState>,

    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleCompetition<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = oracle @ ArenaError::UnauthorizedOracle
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    pub oracle: Signer<'info>,
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
        seeds = [b"participant", competition.key().as_ref(), trader.key().as_ref()],
        bump = participant.bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(
        mut,
        seeds = [b"vault", competition.key().as_ref()],
        bump = competition.vault_bump
    )]
    pub prize_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_token_account.owner == trader.key(),
        constraint = trader_token_account.mint == competition.reward_mint
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct EmergencyAbort<'info> {
    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        has_one = admin @ ArenaError::UnauthorizedAdmin
    )]
    pub competition: Account<'info, CompetitionState>,
    pub admin: Signer<'info>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct CompetitionState {
    pub competition_id: u64,
    pub admin: Pubkey,
    pub oracle: Pubkey,
    pub reward_mint: Pubkey,
    pub prize_vault: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub entry_fee: u64,
    pub min_trade_volume: u64,
    pub reward_distribution_bps: [u16; 3],
    pub total_participants: u64,
    pub total_volume: u64,
    pub settled_prize_pool: u64,
    pub winner_1: Pubkey,
    pub winner_2: Pubkey,
    pub winner_3: Pubkey,
    pub is_settled: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl CompetitionState {
    pub const LEN: usize = 8 + // Discriminator
        8 +  // competition_id
        32 + // admin
        32 + // oracle
        32 + // reward_mint
        32 + // prize_vault
        8 +  // start_ts
        8 +  // end_ts
        8 +  // entry_fee
        8 +  // min_trade_volume
        (2 * 3) + // reward_distribution_bps
        8 +  // total_participants
        8 +  // total_volume
        8 +  // settled_prize_pool
        32 + // winner_1
        32 + // winner_2
        32 + // winner_3
        1 +  // is_settled
        1 +  // bump
        1;   // vault_bump
}

#[account]
pub struct ParticipantState {
    pub competition: Pubkey,
    pub trader: Pubkey,
    pub volume: u64,
    pub realized_pnl: i128,
    pub trades_count: u64,
    pub registered_at: i64,
    pub has_claimed: bool,
    pub final_rank: u8,
    pub bump: u8,
}

impl ParticipantState {
    pub const LEN: usize = 8 + // Discriminator
        32 + // competition
        32 + // trader
        8 +  // volume
        16 + // realized_pnl (i128)
        8 +  // trades_count
        8 +  // registered_at
        1 +  // has_claimed
        1 +  // final_rank
        1;   // bump
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CompetitionCreated {
    pub competition_id: u64,
    pub admin: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub entry_fee: u64,
}

#[event]
pub struct ParticipantRegistered {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub registered_at: i64,
}

#[event]
pub struct TradeRecorded {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub volume_delta: u64,
    pub pnl_delta: i128,
    pub cumulative_volume: u64,
    pub cumulative_pnl: i128,
}

#[event]
pub struct CompetitionSettled {
    pub competition_id: u64,
    pub prize_pool: u64,
    pub winner_1: Pubkey,
    pub winner_2: Pubkey,
    pub winner_3: Pubkey,
    pub settled_at: i64,
}

#[event]
pub struct RewardClaimed {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub rank: u8,
    pub reward_amount: u64,
}

#[event]
pub struct CompetitionAborted {
    pub competition_id: u64,
    pub aborted_at: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub mod ArenaError {
    #[msg("Start timestamp must be in the future or current timestamp.")]
    InvalidStartTime,
    #[msg("End timestamp must be strictly greater than start timestamp.")]
    InvalidEndTime,
    #[msg("Total reward distribution basis points must sum precisely to 10,000 (100%).")]
    InvalidBpsDistribution,
    #[msg("Competition has already concluded.")]
    CompetitionEnded,
    #[msg("Competition has not started yet.")]
    CompetitionNotStarted,
    #[msg("Competition is already settled.")]
    CompetitionAlreadySettled,
    #[msg("Competition is still active; cannot settle prior to end_ts.")]
    CompetitionStillActive,
    #[msg("Competition is not yet settled.")]
    CompetitionNotSettled,
    #[msg("Math calculation resulted in overflow or underflow.")]
    MathOverflow,
    #[msg("Caller is not the authorized oracle for this competition.")]
    UnauthorizedOracle,
    #[msg("Caller is not the authorized admin.")]
    UnauthorizedAdmin,
    #[msg("Participant account does not match competition instance.")]
    ParticipantMismatch,
    #[msg("Caller is not an eligible settled winner.")]
    NotAWinner,
    #[msg("Prize reward has already been claimed by this winner.")]
    RewardAlreadyClaimed,
    #[msg("Trader pubkey does not match claim instruction signer.")]
    UnauthorizedClaim,
}