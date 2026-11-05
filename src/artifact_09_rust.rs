use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::CompetitionError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct RegisterParticipant<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [COMPETITION_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = trader,
        space = Participant::LEN,
        seeds = [
            PARTICIPANT_SEED,
            competition_id.to_le_bytes().as_ref(),
            trader.key().as_ref()
        ],
        bump
    )]
    pub participant: Account<'info, Participant>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = trader,
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RegisterParticipant>, competition_id: u64) -> Result<()> {
    let comp = &mut ctx.accounts.competition;
    let clock = Clock::get()?;

    require!(
        clock.unix_timestamp < comp.end_ts,
        CompetitionError::CompetitionEnded
    );

    let bond_amount = comp.min_stake_bond;
    if bond_amount > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.trader_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), bond_amount)?;
    }

    let participant = &mut ctx.accounts.participant;
    participant.trader = ctx.accounts.trader.key();
    participant.competition_id = competition_id;
    participant.registered_at = clock.unix_timestamp;
    participant.stake_bond = bond_amount;
    participant.qualifying_volume = 0;
    participant.realized_pnl = 0;
    participant.nectar_vault_points = 0;
    participant.raw_score = 0;
    participant.rejected_wash_volume = 0;
    participant.claimed = false;
    participant.bump = ctx.bumps.participant;

    comp.total_registered_participants = comp
        .total_registered_participants
        .checked_add(1)
        .ok_or(CompetitionError::MathOverflow)?;

    Ok(())
}