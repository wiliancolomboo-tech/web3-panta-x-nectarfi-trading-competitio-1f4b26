use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::CompetitionError;
use crate::state::Competition;

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct InitializeCompetition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = Competition::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = authority,
        seeds = [b"reward_vault", competition.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = competition,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeCompetition>,
    competition_id: u64,
    start_timestamp: i64,
    end_timestamp: i64,
    entry_fee: u64,
    min_trade_size: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        start_timestamp >= clock.unix_timestamp && end_timestamp > start_timestamp,
        CompetitionError::InvalidTimestamps
    );

    let comp = &mut ctx.accounts.competition;
    comp.authority = ctx.accounts.authority.key();
    comp.competition_id = competition_id;
    comp.reward_mint = ctx.accounts.reward_mint.key();
    comp.reward_vault = ctx.accounts.reward_vault.key();
    comp.start_timestamp = start_timestamp;
    comp.end_timestamp = end_timestamp;
    comp.entry_fee = entry_fee;
    comp.min_trade_size = min_trade_size;
    comp.total_traders = 0;
    comp.total_volume = 0;
    comp.total_reward_pool = 0;
    comp.merkle_root = [0u8; 32];
    comp.is_finalized = false;
    comp.bump = ctx.bumps.competition;
    comp.vault_bump = ctx.bumps.reward_vault;

    Ok(())
}