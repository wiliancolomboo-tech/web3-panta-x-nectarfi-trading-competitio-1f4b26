use anchor_lang::prelude::*;
use crate::errors::CompetitionError;
use crate::state::{Competition, TraderRecord};

#[derive(Accounts)]
pub struct RecordTrade<'info> {
    #[account(
        constraint = authority.key() == competition.authority @ CompetitionError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [
            b"trader_record",
            competition.key().as_ref(),
            trader_record.trader.as_ref()
        ],
        bump = trader_record.bump
    )]
    pub trader_record: Account<'info, TraderRecord>,
}

pub fn handler(ctx: Context<RecordTrade>, volume: u64, realized_pnl: i64) -> Result<()> {
    let clock = Clock::get()?;
    let comp = &mut ctx.accounts.competition;

    require!(
        clock.unix_timestamp >= comp.start_timestamp && clock.unix_timestamp <= comp.end_timestamp,
        CompetitionError::CompetitionNotActive
    );
    require!(!comp.is_finalized, CompetitionError::AlreadyFinalized);
    require!(volume >= comp.min_trade_size, CompetitionError::TradeVolumeBelowMinimum);

    let trader_record = &mut ctx.accounts.trader_record;
    trader_record.cumulative_volume = trader_record
        .cumulative_volume
        .checked_add(volume)
        .ok_or(CompetitionError::MathOverflow)?;

    trader_record.cumulative_pnl = trader_record
        .cumulative_pnl
        .checked_add(realized_pnl)
        .ok_or(CompetitionError::MathOverflow)?;

    trader_record.total_trades = trader_record
        .total_trades
        .checked_add(1)
        .ok_or(CompetitionError::MathOverflow)?;

    comp.total_volume = comp
        .total_volume
        .checked_add(volume)
        .ok_or(CompetitionError::MathOverflow)?;

    Ok(())
}