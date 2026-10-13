// programs/panta_nectar_competition/src/lib.rs

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_lang::solana_program::keccak;

declare_id!("PNTAnECTAR111111111111111111111111111111111");

#[program]
pub mod panta_nectar_competition {
    use super::*;

    /// Initialize a new trading competition epoch with custom duration, entry fees, and reward pools.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_slot: u64,
        end_slot: u64,
        entry_fee: u64,
        min_trade_volume: u64,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        require!(start_slot >= current_slot, CompetitionError::InvalidStartSlot);
        require!(end_slot > start_slot, CompetitionError::InvalidEndSlot);

        let competition = &mut ctx.accounts.competition;
        competition.authority = ctx.accounts.authority.key();
        competition.reward_mint = ctx.accounts.reward_mint.key();
        competition.escrow_vault = ctx.accounts.escrow_vault.key();
        competition.competition_id = competition_id;
        competition.start_slot = start_slot;
        competition.end_slot = end_slot;
        competition.entry_fee = entry_fee;
        competition.min_trade_volume = min_trade_volume;
        competition.total_participants = 0;
        competition.total_prize_pool = 0;
        competition.is_settled = false;
        competition.merkle_root = [0u8; 32];
        competition.bump = ctx.bumps.competition;
        competition.escrow_bump = ctx.bumps.escrow_vault;

        emit!(CompetitionInitializedEvent {
            competition_id,
            authority: competition.authority,
            start_slot,
            end_slot,
            entry_fee,
        });

        Ok(())
    }

    /// Deposit additional reward funds into the prize vault.
    pub fn fund_prize_pool(ctx: Context<FundPrizePool>, amount: u64) -> Result<()> {
        require!(amount > 0, CompetitionError::ZeroDepositAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        let competition = &mut ctx.accounts.competition;
        competition.total_prize_pool = competition
            .total_prize_pool
            .checked_add(amount)
            .ok_or(CompetitionError::MathOverflow)?;

        emit!(PrizePoolFundedEvent {
            competition_id: competition.competition_id,
            funder: ctx.accounts.funder.key(),
            amount,
            new_total: competition.total_prize_pool,
        });

        Ok(())
    }

    /// Register a user for the competition epoch and deposit required entry fee.
    pub fn register_participant(ctx: Context<RegisterParticipant>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(clock.slot < competition.end_slot, CompetitionError::CompetitionEnded);
        require!(!competition.is_settled, CompetitionError::CompetitionAlreadySettled);

        if competition.entry_fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_ctx, competition.entry_fee)?;

            competition.total_prize_pool = competition
                .total_prize_pool
                .checked_add(competition.entry_fee)
                .ok_or(CompetitionError::MathOverflow)?;
        }

        let participant = &mut ctx.accounts.participant_record;
        participant.competition = competition.key();
        participant.user = ctx.accounts.user.key();
        participant.total_volume = 0;
        participant.realized_pnl = 0;
        participant.last_trade_slot = clock.slot;
        participant.has_claimed = false;
        participant.bump = ctx.bumps.participant_record;

        competition.total_participants = competition
            .total_participants
            .checked_add(1)
            .ok_or(CompetitionError::MathOverflow)?;

        emit!(ParticipantRegisteredEvent {
            competition_id: competition.competition_id,
            user: ctx.accounts.user.key(),
            registered_slot: clock.slot,
        });

        Ok(())
    }

    /// Record a verified Panta DEX trade execution on-chain.
    pub fn record_trade(
        ctx: Context<RecordTrade>,
        volume: u64,
        pnl: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &ctx.accounts.competition;

        require!(clock.slot >= competition.start_slot, CompetitionError::CompetitionNotStarted);
        require!(clock.slot <= competition.end_slot, CompetitionError::CompetitionEnded);
        require!(!competition.is_settled, CompetitionError::CompetitionAlreadySettled);

        let participant = &mut ctx.accounts.participant_record;
        participant.total_volume = participant
            .total_volume
            .checked_add(volume)
            .ok_or(CompetitionError::MathOverflow)?;
        participant.realized_pnl = participant
            .realized_pnl
            .checked_add(pnl)
            .ok_or(CompetitionError::MathOverflow)?;
        participant.last_trade_slot = clock.slot;

        emit!(TradeRecordedEvent {
            competition_id: competition.competition_id,
            user: participant.user,
            trade_volume: volume,
            realized_pnl: pnl,
            cumulative_volume: participant.total_volume,
            cumulative_pnl: participant.realized_pnl,
        });

        Ok(())
    }

    /// Authority or Keeper settles the competition by publishing the final Merkle root.
    pub fn settle_epoch(ctx: Context<SettleEpoch>, merkle_root: [u8; 32]) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(clock.slot > competition.end_slot, CompetitionError::CompetitionStillActive);
        require!(!competition.is_settled, CompetitionError::CompetitionAlreadySettled);

        competition.is_settled = true;
        competition.merkle_root = merkle_root;

        emit!(EpochSettledEvent {
            competition_id: competition.competition_id,
            merkle_root,
            settled_slot: clock.slot,
        });

        Ok(())
    }

    /// Claim rewards via Merkle proof verification after epoch finalization.
    pub fn claim_reward(
        ctx: Context<ClaimReward>,
        claim_amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let participant = &mut ctx.accounts.participant_record;

        require!(competition.is_settled, CompetitionError::CompetitionNotSettled);
        require!(!participant.has_claimed, CompetitionError::RewardAlreadyClaimed);
        require!(claim_amount > 0, CompetitionError::ZeroClaimAmount);

        // Verify Merkle leaf: keccak256(user_pubkey || claim_amount)
        let mut leaf_data = Vec::with_capacity(32 + 8);
        leaf_data.extend_from_slice(participant.user.as_ref());
        leaf_data.extend_from_slice(&claim_amount.to_le_bytes());
        let computed_leaf = keccak::hash(&leaf_data).to_bytes();

        let is_valid = verify_merkle_proof(computed_leaf, &proof, competition.merkle_root);
        require!(is_valid, CompetitionError::InvalidMerkleProof);

        participant.has_claimed = true;

        let comp_id_bytes = competition.competition_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"escrow",
            competition.to_account_info().key.as_ref(),
            &[competition.escrow_bump],
        ]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.user_reward_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, seeds);
        token::transfer(cpi_ctx, claim_amount)?;

        emit!(RewardClaimedEvent {
            competition_id: competition.competition_id,
            user: participant.user,
            reward_amount: claim_amount,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------
pub fn verify_merkle_proof(leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut current_hash = leaf;
    for sibling in proof.iter() {
        let mut combined = [0u8; 64];
        if current_hash <= *sibling {
            combined[..32].copy_from_slice(&current_hash);
            combined[32..].copy_from_slice(sibling);
        } else {
            combined[..32].copy_from_slice(sibling);
            combined[32..].copy_from_slice(&current_hash);
        }
        current_hash = keccak::hash(&combined).to_bytes();
    }
    current_hash == root
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------
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
        token::authority = escrow_vault,
        seeds = [b"escrow", competition.key().as_ref()],
        bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundPrizePool<'info> {
    #[account(
        mut,
        has_one = escrow_vault @ CompetitionError::InvalidEscrowVault,
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RegisterParticipant<'info> {
    #[account(
        mut,
        has_one = escrow_vault @ CompetitionError::InvalidEscrowVault,
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = user,
        space = 8 + ParticipantRecord::LEN,
        seeds = [b"participant", competition.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub participant_record: Account<'info, ParticipantRecord>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecordTrade<'info> {
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), participant_record.user.as_ref()],
        bump = participant_record.bump
    )]
    pub participant_record: Account<'info, ParticipantRecord>,

    #[account(
        constraint = authority.key() == competition.authority @ CompetitionError::UnauthorizedSigner
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleEpoch<'info> {
    #[account(
        mut,
        has_one = authority @ CompetitionError::UnauthorizedSigner
    )]
    pub competition: Account<'info, CompetitionState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(
        has_one = escrow_vault @ CompetitionError::InvalidEscrowVault,
    )]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        seeds = [b"participant", competition.key().as_ref(), user.key().as_ref()],
        bump = participant_record.bump,
        has_one = user @ CompetitionError::UnauthorizedSigner
    )]
    pub participant_record: Account<'info, ParticipantRecord>,

    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_reward_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STORAGE STRUCTS
// -----------------------------------------------------------------------------
#[account]
pub struct CompetitionState {
    pub authority: Pubkey,          // 32
    pub reward_mint: Pubkey,        // 32
    pub escrow_vault: Pubkey,       // 32
    pub competition_id: u64,        // 8
    pub start_slot: u64,            // 8
    pub end_slot: u64,              // 8
    pub entry_fee: u64,             // 8
    pub min_trade_volume: u64,      // 8
    pub total_participants: u64,    // 8
    pub total_prize_pool: u64,      // 8
    pub is_settled: bool,           // 1
    pub merkle_root: [u8; 32],      // 32
    pub bump: u8,                   // 1
    pub escrow_bump: u8,            // 1
}

impl CompetitionState {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 32 + 1 + 1;
}

#[account]
pub struct ParticipantRecord {
    pub competition: Pubkey,        // 32
    pub user: Pubkey,               // 32
    pub total_volume: u64,          // 8
    pub realized_pnl: i64,          // 8
    pub last_trade_slot: u64,       // 8
    pub has_claimed: bool,          // 1
    pub bump: u8,                   // 1
}

impl ParticipantRecord {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 1 + 1;
}

// -----------------------------------------------------------------------------
// ERROR DEFINITIONS
// -----------------------------------------------------------------------------
#[error_code]
pub enum CompetitionError {
    #[msg("Competition start slot must be in the future.")]
    InvalidStartSlot,
    #[msg("Competition end slot must be greater than start slot.")]
    InvalidEndSlot,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDepositAmount,
    #[msg("Mathematical overflow occurred during accounting.")]
    MathOverflow,
    #[msg("Competition has already concluded.")]
    CompetitionEnded,
    #[msg("Competition has not started yet.")]
    CompetitionNotStarted,
    #[msg("Competition is already finalized and settled.")]
    CompetitionAlreadySettled,
    #[msg("Escrow vault validation mismatch.")]
    InvalidEscrowVault,
    #[msg("Unauthorized signer for this action.")]
    UnauthorizedSigner,
    #[msg("Competition is still ongoing; cannot settle before end_slot.")]
    CompetitionStillActive,
    #[msg("Competition is not settled yet.")]
    CompetitionNotSettled,
    #[msg("Prize reward has already been claimed.")]
    RewardAlreadyClaimed,
    #[msg("Claim amount must be greater than zero.")]
    ZeroClaimAmount,
    #[msg("Cryptographic Merkle proof verification failed.")]
    InvalidMerkleProof,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------
#[event]
pub struct CompetitionInitializedEvent {
    pub competition_id: u64,
    pub authority: Pubkey,
    pub start_slot: u64,
    pub end_slot: u64,
    pub entry_fee: u64,
}

#[event]
pub struct PrizePoolFundedEvent {
    pub competition_id: u64,
    pub funder: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct ParticipantRegisteredEvent {
    pub competition_id: u64,
    pub user: Pubkey,
    pub registered_slot: u64,
}

#[event]
pub struct TradeRecordedEvent {
    pub competition_id: u64,
    pub user: Pubkey,
    pub trade_volume: u64,
    pub realized_pnl: i64,
    pub cumulative_volume: u64,
    pub cumulative_pnl: i64,
}

#[event]
pub struct EpochSettledEvent {
    pub competition_id: u64,
    pub merkle_root: [u8; 32],
    pub settled_slot: u64,
}

#[event]
pub struct RewardClaimedEvent {
    pub competition_id: u64,
    pub user: Pubkey,
    pub reward_amount: u64,
}