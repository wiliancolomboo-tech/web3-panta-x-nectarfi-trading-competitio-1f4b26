use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::CompetitionError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct FinalizeCompetition<'info> {
    #[account(
        constraint = admin.key() == competition.admin @ CompetitionError::Unauthorized
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [COMPETITION_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
    )]
    pub competition: Account<'info, Competition>,
}

pub fn finalize_handler(
    ctx: Context<FinalizeCompetition>,
    _competition_id: u64,
    merkle_root: [u8; 32],
) -> Result<()> {
    let comp = &mut ctx.accounts.competition;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp >= comp.end_ts, CompetitionError::CompetitionNotStarted);
    require!(comp.status == CompetitionStatus::Active, CompetitionError::CompetitionAlreadyFinalized);

    comp.status = CompetitionStatus::Finalized;
    comp.merkle_root = merkle_root;

    Ok(())
}

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [COMPETITION_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.bump,
        constraint = competition.status == CompetitionStatus::Finalized @ CompetitionError::CompetitionNotFinalized
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [
            PARTICIPANT_SEED,
            competition_id.to_le_bytes().as_ref(),
            trader.key().as_ref()
        ],
        bump = participant.bump,
        constraint = !participant.claimed @ CompetitionError::RewardAlreadyClaimed
    )]
    pub participant: Account<'info, Participant>,

    #[account(
        mut,
        seeds = [VAULT_SEED, competition_id.to_le_bytes().as_ref()],
        bump = competition.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::authority = trader,
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_handler(
    ctx: Context<ClaimReward>,
    competition_id: u64,
    reward_amount: u64,
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    let comp = &ctx.accounts.competition;
    let participant = &mut ctx.accounts.participant;

    // Verify Merkle Proof: Leaf = keccak256(trader_pubkey || reward_amount)
    let mut leaf = anchor_lang::solana_program::keccak::hashv(&[
        ctx.accounts.trader.key().as_ref(),
        &reward_amount.to_le_bytes(),
    ]).0;

    for proof_element in merkle_proof.iter() {
        if leaf <= *proof_element {
            leaf = anchor_lang::solana_program::keccak::hashv(&[&leaf, proof_element]).0;
        } else {
            leaf = anchor_lang::solana_program::keccak::hashv(&[proof_element, &leaf]).0;
        }
    }

    require!(leaf == comp.merkle_root, CompetitionError::InvalidMerkleProof);

    participant.claimed = true;

    // Return stake bond + competition reward payout
    let total_disbursement = reward_amount
        .checked_add(participant.stake_bond)
        .ok_or(CompetitionError::MathOverflow)?;

    let competition_id_bytes = competition_id.to_le_bytes();
    let seeds = &[
        COMPETITION_SEED,
        competition_id_bytes.as_ref(),
        &[comp.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.trader_token_account.to_account_info(),
        authority: ctx.accounts.competition.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::transfer(
        CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
        total_disbursement,
    )?;

    Ok(())
}