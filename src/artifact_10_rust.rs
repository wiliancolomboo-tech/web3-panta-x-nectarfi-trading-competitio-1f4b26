use anchor_lang::prelude::*;
use crate::errors::CompetitionError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct UpdateMetrics<'info> {
    #[account(
        constraint = oracle_authority.key() == competition.oracle_authority @ CompetitionError::Unauthorized
    )]
    pub oracle_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [COMPETITION_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        constraint = competition.status == CompetitionStatus::Active @ CompetitionError::CompetitionEnded
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [
            PARTICIPANT_SEED,
            competition_id.to_le_bytes().as_ref(),
            participant.trader.as_ref()
        ],
        bump = participant.bump,
    )]
    pub participant: Account<'info, Participant>,
}

pub fn handler(
    ctx: Context<UpdateMetrics>,
    _competition_id: u64,
    incremental_volume: u64,
    incremental_pnl: i64,
    nectar_lp_points: u64,
    is_wash_trade: bool,
) -> Result<()> {
    let clock = Clock::get()?;
    let comp = &mut ctx.accounts.competition;

    require!(clock.unix_timestamp <= comp.end_ts, CompetitionError::CompetitionEnded);

    let participant = &mut ctx.accounts.participant;

    if is_wash_trade {
        participant.rejected_wash_volume = participant
            .rejected_wash_volume
            .checked_add(incremental_volume)
            .ok_or(CompetitionError::MathOverflow)?;
        return Ok(());
    }

    participant.qualifying_volume = participant
        .qualifying_volume
        .checked_add(incremental_volume)
        .ok_or(CompetitionError::MathOverflow)?;

    participant.realized_pnl = participant
        .realized_pnl
        .checked_add(incremental_pnl)
        .ok_or(CompetitionError::MathOverflow)?;

    participant.nectar_vault_points = participant
        .nectar_vault_points
        .checked_add(nectar_lp_points)
        .ok_or(CompetitionError::MathOverflow)?;

    comp.total_qualifying_volume = comp
        .total_qualifying_volume
        .checked_add(incremental_volume as u128)
        .ok_or(CompetitionError::MathOverflow)?;

    // Weighted Score Formula: (PnL normalized) + (0.01 * volume) + (5 * nectar LP points)
    let pnl_component: i128 = participant.realized_pnl as i128;
    let vol_component: u128 = (participant.qualifying_volume / 100) as u128;
    let nectar_component: u128 = (participant.nectar_vault_points as u128)
        .checked_mul(5)
        .unwrap_or(0);

    let calculated_score = (pnl_component.max(0) as u128)
        .checked_add(vol_component)
        .and_then(|v| v.checked_add(nectar_component))
        .unwrap_or(0);

    participant.raw_score = calculated_score;

    Ok(())
}