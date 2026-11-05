use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::CompetitionError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub防火wall Context
pub struct InitializeCompetition<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Checked as authorized oracle signer
    pub oracle_authority: UncheckedAccount<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = Competition::LEN,
        seeds = [COMPETITION_SEED, competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, competition_id.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = competition,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeCompetition>,
    competition_id: u64,
    start_ts: i64,
    end_ts: i64,
    min_stake_bond: u64,
    total_reward_amount: u64,
) -> Result<()> {
    require!(start_ts < end_ts, CompetitionError::InvalidTimeBounds);

    let comp = &mut ctx.accounts.competition;
    comp.admin = ctx.accounts.admin.key();
    comp.oracle_authority = ctx.accounts.oracle_authority.key();
    comp.reward_mint = ctx.accounts.reward_mint.key();
    comp.vault = ctx.accounts.vault.key();
    comp.competition_id = competition_id;
    comp.start_ts = start_ts;
    comp.end_ts = end_ts;
    comp.min_stake_bond = min_stake_bond;
    comp.total_reward_amount = total_reward_amount;
    comp.total_registered_participants = 0;
    comp.total_qualifying_volume = 0;
    comp.status = CompetitionStatus::Active;
    comp.merkle_root = [0u8; 32];
    comp.bump = ctx.bumps.competition;
    comp.vault_bump = ctx.bumps.vault;

    if total_reward_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), total_reward_amount)?;
    }

    Ok(())
}