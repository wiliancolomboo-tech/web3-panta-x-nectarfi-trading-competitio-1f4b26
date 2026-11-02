use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_program::keccak;
use crate::errors::CompetitionError;
use crate::state::{Competition, TraderRecord};

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        seeds = [b"competition", competition.competition_id.to_le_bytes().as_ref()],
        bump = competition.bump
    )]
    pub competition: Account<'info, Competition>,

    #[account(
        mut,
        seeds = [
            b"trader_record",
            competition.key().as_ref(),
            claimant.key().as_ref()
        ],
        bump = trader_record.bump
    )]
    pub trader_record: Account<'info, TraderRecord>,

    #[account(
        mut,
        address = competition.reward_vault
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = claimant_token_account.mint == competition.reward_mint,
        constraint = claimant_token_account.owner == claimant.key()
    )]
    pub claimant_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn verify_merkle_proof(
    proof: Vec<[u8; 32]>,
    root: [u8; 32],
    leaf: [u8; 32],
) -> bool {
    let mut computed_hash = leaf;

    for proof_element in proof.into_iter() {
        if computed_hash <= proof_element {
            computed_hash = keccak::hashv(&[&computed_hash, &proof_element]).0;
        } else {
            computed_hash = keccak::hashv(&[&proof_element, &computed_hash]).0;
        }
    }

    computed_hash == root
}

pub fn handler(
    ctx: Context<ClaimPrize>,
    index: u32,
    amount: u64,
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    let comp = &ctx.accounts.competition;
    let trader_record = &mut ctx.accounts.trader_record;

    require!(comp.is_finalized, CompetitionError::NotFinalized);
    require!(!trader_record.has_claimed, CompetitionError::PrizeAlreadyClaimed);

    // Leaf format: hash(index || trader_pubkey || amount)
    let mut payload = Vec::with_capacity(4 + 32 + 8);
    payload.extend_from_slice(&index.to_le_bytes());
    payload.extend_from_slice(ctx.accounts.claimant.key().as_ref());
    payload.extend_from_slice(&amount.to_le_bytes());
    let leaf = keccak::hash(&payload).0;

    require!(
        verify_merkle_proof(merkle_proof, comp.merkle_root, leaf),
        CompetitionError::InvalidMerkleProof
    );

    trader_record.has_claimed = true;

    // Transfer prize via PDA authority seeds
    let competition_id_bytes = comp.competition_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"competition",
        competition_id_bytes.as_ref(),
        &[comp.bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_vault.to_account_info(),
                to: ctx.accounts.claimant_token_account.to_account_info(),
                authority: ctx.accounts.competition.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    Ok(())
}