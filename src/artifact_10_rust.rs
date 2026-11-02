use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::CompetitionError;
use crate::state::{Competition, TraderRecord};

#[derive(Accounts)]
pub struct RegisterTrader<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        init,
        payer = trader,
        space = TraderRecord::LEN,
        seeds = [
            b"trader_record",
            competition.key().as_ref(),
            trader.key().as_ref()
        ],
        bump
    )]
    pub trader_record: Account<'info, TraderRecord>,

    #[account(
        mut,
        address = competition.reward_vault
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_token_account.mint == competition.reward_mint
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RegisterTrader>) -> Result<()> {
    let clock = Clock::get()?;
    let comp = &ctx.accounts.competition;

    require!(
        clock.unix_timestamp < comp.end_timestamp,
        CompetitionError::CompetitionEnded
    );

    if comp.entry_fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_token_account.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            comp.entry_fee,
        )?;
    }

    let trader_record = &mut ctx.accounts.trader_record;
    trader_record.competition = comp.key();
    trader_record.trader = ctx.accounts.trader.key();
    trader_record.registered_timestamp = clock.unix_timestamp;
    trader_record.cumulative_volume = 0;
    trader_record.cumulative_pnl = 0;
    trader_record.total_trades = 0;
    trader_record.has_claimed = false;
    trader_record.bump = ctx.bumps.trader_record;

    let comp_mut = &mut ctx.accounts.competition;
    comp_mut.total_traders = comp_mut.total_traders.checked_add(1).unwrap();
    if comp.entry_fee > 0 {
        comp_mut.total_reward_pool = comp_mut
            .total_reward_pool
            .checked_add(comp.entry_fee)
            .unwrap();
    }

    Ok(())
}