use anchor_lang::prelude::*;
use crate::errors::CompetitionError;
use crate::state::Competition;

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        constraint = authority.key() == competition.authority @ CompetitionError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,
}

pub fn handler(
    ctx: Context<FinalizeCompetition>,
    merkle_root: [u8; 32],
    total_qualifying_volume: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let comp = &mut ctx.accounts.competition;

    require!(
        clock.unix_timestamp > comp.end_timestamp,
        CompetitionError::CompetitionNotEnded
    );
    require!(!comp.is_finalized, CompetitionError::AlreadyFinalized);

    comp.merkle_root = merkle_root;
    comp.is_finalized = true;
    comp.total_volume = total_qualifying_volume;

    Ok(())
}