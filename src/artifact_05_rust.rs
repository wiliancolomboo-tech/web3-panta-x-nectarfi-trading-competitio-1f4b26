use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PANTAn1ck1111111111111111111111111111111111");

#[program]
pub mod panta_nectar_competition {
    use super::*;

    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_ts: i64,
        end_ts: i64,
        min_registration_fee: u64,
        max_traders: u32,
        total_reward_pool: u64,
    ) -> Result<()> {
        require!(start_ts < end_ts, CompetitionError::InvalidTimestamps);
        require!(total_reward_pool > 0, CompetitionError::InvalidRewardAmount);

        let competition = &mut ctx.accounts.competition;
        competition.authority = ctx.accounts.authority.key();
        competition.keeper = ctx.accounts.keeper.key();
        competition.competition_id = competition_id;
        competition.reward_mint = ctx.accounts.reward_mint.key();
        competition.escrow_vault = ctx.accounts.reward_escrow.key();
        competition.start_ts = start_ts;
        competition.end_ts = end_ts;
        competition.min_registration_fee = min_registration_fee;
        competition.max_traders = max_traders;
        competition.registered_count = 0;
        competition.total_reward_pool = total_reward_pool;
        competition.is_finalized = false;
        competition.bump = ctx.bumps.competition;
        competition.escrow_bump = ctx.bumps.reward_escrow;

        // Transfer prize pool tokens from sponsor into escrow PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.reward_escrow.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), total_reward_pool)?;

        emit!(CompetitionInitializedEvent {
            competition_id,
            authority: competition.authority,
            reward_mint: competition.reward_mint,
            total_reward_pool,
            start_ts,
            end_ts,
        });

        Ok(())
    }

    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        let clock = Clock::get()?;

        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);
        require!(clock.unix_timestamp < competition.end_ts, CompetitionError::CompetitionEnded);
        require!(competition.registered_count < competition.max_traders, CompetitionError::MaxTradersExceeded);

        let trader_account = &mut ctx.accounts.trader_account;
        trader_account.trader = ctx.accounts.trader.key();
        trader_account.competition = competition.key();
        trader_account.registered_at = clock.unix_timestamp;
        trader_account.volume_usd = 0;
        trader_account.pnl_scaled = 0;
        trader_account.final_rank = 0;
        trader_account.allocated_reward = 0;
        trader_account.has_claimed = false;
        trader_account.bump = ctx.bumps.trader_account;

        competition.registered_count = competition.registered_count.checked_add(1)
            .ok_or(CompetitionError::ArithmeticOverflow)?;

        emit!(TraderRegisteredEvent {
            competition_id: competition.competition_id,
            trader: ctx.accounts.trader.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn commit_epoch_scores(
        ctx: Context<CommitEpochScores>,
        trader_key: Pubkey,
        volume_increment: u64,
        pnl_scaled_update: i64,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let clock = Clock::get()?;

        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);
        require!(clock.unix_timestamp >= competition.start_ts, CompetitionError::CompetitionNotStarted);
        require!(clock.unix_timestamp <= competition.end_ts, CompetitionError::CompetitionEnded);

        let trader_record = &mut ctx.accounts.trader_account;
        require!(trader_record.trader == trader_key, CompetitionError::TraderMismatch);

        trader_record.volume_usd = trader_record.volume_usd
            .checked_add(volume_increment)
            .ok_or(CompetitionError::ArithmeticOverflow)?;
        trader_record.pnl_scaled = pnl_scaled_update;

        emit!(EpochScoreCommittedEvent {
            competition_id: competition.competition_id,
            trader: trader_key,
            total_volume_usd: trader_record.volume_usd,
            pnl_scaled: trader_record.pnl_scaled,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>
    ) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        let clock = Clock::get()?;

        require!(!competition.is_finalized, CompetitionError::CompetitionAlreadyFinalized);
        require!(clock.unix_timestamp >= competition.end_ts, CompetitionError::CompetitionStillActive);

        competition.is_finalized = true;

        emit!(CompetitionFinalizedEvent {
            competition_id: competition.competition_id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn assign_reward(
        ctx: Context<AssignReward>,
        trader_key: Pubkey,
        rank: u32,
        reward_amount: u64,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);

        let trader_record = &mut ctx.accounts.trader_account;
        require!(trader_record.trader == trader_key, CompetitionError::TraderMismatch);
        require!(trader_record.final_rank == 0, CompetitionError::RewardAlreadyAssigned);

        trader_record.final_rank = rank;
        trader_record.allocated_reward = reward_amount;

        emit!(RewardAssignedEvent {
            competition_id: competition.competition_id,
            trader: trader_key,
            rank,
            reward_amount,
        });

        Ok(())
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let trader_record = &mut ctx.accounts.trader_account;

        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);
        require!(!trader_record.has_claimed, CompetitionError::AlreadyClaimed);
        require!(trader_record.allocated_reward > 0, CompetitionError::ZeroRewardAllocated);

        let payout_amount = trader_record.allocated_reward;
        trader_record.has_claimed = true;

        let comp_key = competition.key();
        let seeds = &[
            b"escrow",
            comp_key.as_ref(),
            &[competition.escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_escrow.to_account_info(),
            to: ctx.accounts.trader_token_account.to_account_info(),
            authority: ctx.accounts.reward_escrow.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            payout_amount,
        )?;

        emit!(RewardClaimedEvent {
            competition_id: competition.competition_id,
            trader: trader_record.trader,
            claimed_amount: payout_amount,
        });

        Ok(())
    }
}

// ----------------------------------------------------------------------------
// Account Structs
// ----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + CompetitionState::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, CompetitionState>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = reward_mint,
        token::authority = reward_escrow,
        seeds = [b"escrow", competition.key().as_ref()],
        bump
    )]
    pub reward_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_token_account.mint == reward_mint.key()
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    /// CHECK: Keeper authority validated for signed score commitments
    pub keeper: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterTrader<'info> {
    #[account(mut)]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = trader,
        space = 8 + TraderAccount::LEN,
        seeds = [b"trader", competition.key().as_ref(), trader.key().as_ref()],
        bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitEpochScores<'info> {
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"trader", competition.key().as_ref(), trader_account.trader.key().as_ref()],
        bump = trader_account.bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(
        address = competition.keeper @ CompetitionError::UnauthorizedKeeper
    )]
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        has_one = authority @ CompetitionError::UnauthorizedAuthority
    )]
    pub competition: Account<'info, CompetitionState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AssignReward<'info> {
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"trader", competition.key().as_ref(), trader_account.trader.key().as_ref()],
        bump = trader_account.bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(
        address = competition.authority @ CompetitionError::UnauthorizedAuthority
    )]
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
        seeds = [b"trader", competition.key().as_ref(), trader.key().as_ref()],
        bump = trader_account.bump
    )]
    pub trader_account: Account<'info, TraderAccount>,

    #[account(
        mut,
        seeds = [b"escrow", competition.key().as_ref()],
        bump = competition.escrow_bump
    )]
    pub reward_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_token_account.mint == competition.reward_mint,
        constraint = trader_token_account.owner == trader.key()
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ----------------------------------------------------------------------------
// State Data Layout
// ----------------------------------------------------------------------------

#[account]
pub struct CompetitionState {
    pub authority: Pubkey,         // 32
    pub keeper: Pubkey,            // 32
    pub competition_id: u64,       // 8
    pub reward_mint: Pubkey,       // 32
    pub escrow_vault: Pubkey,      // 32
    pub start_ts: i64,             // 8
    pub end_ts: i64,               // 8
    pub min_registration_fee: u64, // 8
    pub max_traders: u32,          // 4
    pub registered_count: u32,     // 4
    pub total_reward_pool: u64,    // 8
    pub is_finalized: bool,        // 1
    pub bump: u8,                  // 1
    pub escrow_bump: u8,           // 1
}

impl CompetitionState {
    pub const LEN: usize = 32 + 32 + 8 + 32 + 32 + 8 + 8 + 8 + 4 + 4 + 8 + 1 + 1 + 1 + 64; // with buffer
}

#[account]
pub struct TraderAccount {
    pub trader: Pubkey,         // 32
    pub competition: Pubkey,    // 32
    pub registered_at: i64,     // 8
    pub volume_usd: u64,        // 8
    pub pnl_scaled: i64,        // 8 (scaled by 1e6, can be negative)
    pub final_rank: u32,        // 4
    pub allocated_reward: u64,  // 8
    pub has_claimed: bool,      // 1
    pub bump: u8,               // 1
}

impl TraderAccount {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 4 + 8 + 1 + 1 + 32; // with buffer
}

// ----------------------------------------------------------------------------
// Events & Errors
// ----------------------------------------------------------------------------

#[event]
pub struct CompetitionInitializedEvent {
    pub competition_id: u64,
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub total_reward_pool: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

#[event]
pub struct TraderRegisteredEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct EpochScoreCommittedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub total_volume_usd: u64,
    pub pnl_scaled: i64,
    pub timestamp: i64,
}

#[event]
pub struct CompetitionFinalizedEvent {
    pub competition_id: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardAssignedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub rank: u32,
    pub reward_amount: u64,
}

#[event]
pub struct RewardClaimedEvent {
    pub competition_id: u64,
    pub trader: Pubkey,
    pub claimed_amount: u64,
}

#[error_code]
pub enum CompetitionError {
    #[msg("Invalid competition start or end timestamps.")]
    InvalidTimestamps,
    #[msg("Total reward pool must be greater than zero.")]
    InvalidRewardAmount,
    #[msg("Competition has already been finalized.")]
    CompetitionAlreadyFinalized,
    #[msg("Competition period has already ended.")]
    CompetitionEnded,
    #[msg("Competition has not started yet.")]
    CompetitionNotStarted,
    #[msg("Competition is still active; cannot finalize yet.")]
    CompetitionStillActive,
    #[msg("Competition is not finalized yet.")]
    CompetitionNotFinalized,
    #[msg("Maximum trader registration limit exceeded.")]
    MaxTradersExceeded,
    #[msg("Unauthorized keeper account attempted state update.")]
    UnauthorizedKeeper,
    #[msg("Unauthorized authority account.")]
    UnauthorizedAuthority,
    #[msg("Trader public key does not match target account.")]
    TraderMismatch,
    #[msg("Arithmetic overflow or underflow detected.")]
    ArithmeticOverflow,
    #[msg("Trader reward has already been assigned.")]
    RewardAlreadyAssigned,
    #[msg("Trader has already claimed their competition reward.")]
    AlreadyClaimed,
    #[msg("Zero reward allocated to this trader account.")]
    ZeroRewardAllocated,
}