use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PNTAnect11111111111111111111111111111111111");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_NAME_LENGTH: usize = 32;

#[program]
pub mod panta_nectar_competition {
    use super::*;

    /// Initializes a new verifiable trading competition with designated scoring parameters.
    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        name: String,
        start_ts: i64,
        end_ts: i64,
        min_volume_threshold: u64,
        merkle_root_update_authority: Pubkey,
    ) -> Result<()> {
        require!(name.as_bytes().len() <= MAX_NAME_LENGTH, CompetitionError::NameTooLong);
        require!(start_ts < end_ts, CompetitionError::InvalidTimeRange);
        
        let clock = Clock::get()?;
        require!(end_ts > clock.unix_timestamp, CompetitionError::CompetitionAlreadyEnded);

        let competition = &mut ctx.accounts.competition;
        competition.admin = ctx.accounts.admin.key();
        competition.competition_id = competition_id;
        competition.name = name;
        competition.start_ts = start_ts;
        competition.end_ts = end_ts;
        competition.min_volume_threshold = min_volume_threshold;
        competition.merkle_root_update_authority = merkle_root_update_authority;
        competition.reward_mint = ctx.accounts.reward_mint.key();
        competition.escrow_vault = ctx.accounts.escrow_vault.key();
        competition.escrow_bump = ctx.bumps.escrow_vault;
        competition.is_finalized = false;
        competition.final_merkle_root = [0u8; 32];
        competition.total_prize_pool = 0;
        competition.total_participants = 0;

        emit!(CompetitionInitializedEvent {
            competition_id,
            admin: competition.admin,
            start_ts,
            end_ts,
            reward_mint: competition.reward_mint,
        });

        Ok(())
    }

    /// Traders register on-chain to join the competition.
    pub fn register_participant(ctx: Context<RegisterParticipant>) -> Result<()> {
        let clock = Clock::get()?;
        let competition = &mut ctx.accounts.competition;

        require!(clock.unix_timestamp < competition.end_ts, CompetitionError::CompetitionAlreadyEnded);
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);

        let participant = &mut ctx.accounts.participant;
        participant.competition = competition.key();
        participant.user = ctx.accounts.user.key();
        participant.registered_at = clock.unix_timestamp;
        participant.cumulative_volume = 0;
        participant.has_claimed = false;

        competition.total_participants = competition
            .total_participants
            .checked_add(1)
            .ok_or(CompetitionError::ArithmeticOverflow)?;

        emit!(ParticipantRegisteredEvent {
            competition_id: competition.competition_id,
            user: participant.user,
            registered_at: participant.registered_at,
        });

        Ok(())
    }

    /// Fund the non-custodial prize pool escrow account.
    pub fn fund_prize_pool(ctx: Context<FundPrizePool>, amount: u64) -> Result<()> {
        require!(amount > 0, CompetitionError::ZeroAmount);
        let competition = &mut ctx.accounts.competition;
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        competition.total_prize_pool = competition
            .total_prize_pool
            .checked_add(amount)
            .ok_or(CompetitionError::ArithmeticOverflow)?;

        emit!(PrizePoolFundedEvent {
            competition_id: competition.competition_id,
            funder: ctx.accounts.funder.key(),
            amount,
            new_total: competition.total_prize_pool,
        });

        Ok(())
    }

    /// Authorized keeper oracle finalizes the competition and anchors the Merkle root of scores.
    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        let competition = &mut ctx.accounts.competition;
        let clock = Clock::get()?;

        require!(clock.unix_timestamp >= competition.end_ts, CompetitionError::CompetitionStillActive);
        require!(!competition.is_finalized, CompetitionError::CompetitionFinalized);
        require!(merkle_root != [0u8; 32], CompetitionError::InvalidMerkleRoot);

        competition.final_merkle_root = merkle_root;
        competition.is_finalized = true;

        emit!(CompetitionFinalizedEvent {
            competition_id: competition.competition_id,
            merkle_root,
            finalized_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Participants claim their reward token distribution using an unforgeable Merkle proof.
    pub fn claim_prize(
        ctx: Context<ClaimPrize>,
        rank: u32,
        amount: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let competition = &ctx.accounts.competition;
        let claim_record = &mut ctx.accounts.claim_record;

        require!(competition.is_finalized, CompetitionError::CompetitionNotFinalized);
        require!(!claim_record.has_claimed, CompetitionError::AlreadyClaimed);
        require!(amount > 0, CompetitionError::ZeroAmount);

        // Verify cryptographic Merkle leaf: leaf = keccak256(user_pubkey || rank || amount)
        let leaf = anchor_lang::solana_program::keccak::hashv(&[
            ctx.accounts.user.key().as_ref(),
            &rank.to_le_bytes(),
            &amount.to_le_bytes(),
        ]);

        let is_valid = verify_merkle_proof(&merkle_proof, competition.final_merkle_root, leaf.0);
        require!(is_valid, CompetitionError::InvalidMerkleProof);

        // Mark claimed state in deterministic claim PDA
        claim_record.competition = competition.key();
        claim_record.user = ctx.accounts.user.key();
        claim_record.claimed_at = Clock::get()?.unix_timestamp;
        claim_record.amount = amount;
        claim_record.rank = rank;
        claim_record.has_claimed = true;

        // Perform PDA token transfer from escrow vault to participant
        let comp_key = competition.key();
        let seeds = &[
            b"escrow_vault",
            comp_key.as_ref(),
            &[competition.escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            amount,
        )?;

        emit!(PrizeClaimedEvent {
            competition_id: competition.competition_id,
            user: ctx.accounts.user.key(),
            rank,
            amount,
        });

        Ok(())
    }
}

/// Helper function to cryptographically verify standard Keccak Merkle proofs
pub fn verify_merkle_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed_hash = leaf;

    for proof_element in proof.iter() {
        if computed_hash <= *proof_element {
            computed_hash = anchor_lang::solana_program::keccak::hashv(&[
                &computed_hash,
                proof_element,
            ]).0;
        } else {
            computed_hash = anchor_lang::solana_program::keccak::hashv(&[
                proof_element,
                &computed_hash,
            ]).0;
        }
    }

    computed_hash == root
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(competition_id: u64)]
pub火
pub struct InitializeCompetition<'info> {
    #[account(
        init,
        payer = admin,
        space = DISCRIMINATOR_LENGTH + CompetitionState::LEN,
        seeds = [b"competition", competition_id.to_le_bytes().as_ref()],
        bump
    )]
    pub competition: Account<'info, CompetitionState>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"escrow_vault", competition.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = escrow_vault,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterParticipant<'info> {
    #[account(mut)]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = user,
        space = DISCRIMINATOR_LENGTH + ParticipantState::LEN,
        seeds = [b"participant", competition.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub participant: Account<'info, ParticipantState>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPrizePool<'info> {
    #[account(mut)]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        mut,
        constraint = escrow_vault.key() == competition.escrow_vault @ CompetitionError::InvalidEscrowVault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token_account.mint == competition.reward_mint @ CompetitionError::InvalidRewardMint
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeCompetition<'info> {
    #[account(
        mut,
        constraint = keeper.key() == competition.merkle_root_update_authority @ CompetitionError::UnauthorizedKeeper
    )]
    pub competition: Account<'info, CompetitionState>,

    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub competition: Account<'info, CompetitionState>,

    #[account(
        init,
        payer = user,
        space = DISCRIMINATOR_LENGTH + ClaimRecord::LEN,
        seeds = [b"claim", competition.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    #[account(
        mut,
        seeds = [b"escrow_vault", competition.key().as_ref()],
        bump = competition.escrow_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ CompetitionError::InvalidTokenOwner,
        constraint = user_token_account.mint == competition.reward_mint @ CompetitionError::InvalidRewardMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct CompetitionState {
    pub admin: Pubkey,                        // 32
    pub competition_id: u64,                  // 8
    pub name: String,                          // 4 + 32
    pub start_ts: i64,                         // 8
    pub end_ts: i64,                           // 8
    pub min_volume_threshold: u64,             // 8
    pub merkle_root_update_authority: Pubkey,  // 32
    pub reward_mint: Pubkey,                   // 32
    pub escrow_vault: Pubkey,                  // 32
    pub escrow_bump: u8,                       // 1
    pub is_finalized: bool,                    // 1
    pub final_merkle_root: [u8; 32],           // 32
    pub total_prize_pool: u64,                 // 8
    pub total_participants: u64,               // 8
}

impl CompetitionState {
    pub const LEN: usize = 32 + 8 + (4 + MAX_NAME_LENGTH) + 8 + 8 + 8 + 32 + 32 + 32 + 1 + 1 + 32 + 8 + 8;
}

#[account]
pub struct ParticipantState {
    pub competition: Pubkey,     // 32
    pub user: Pubkey,            // 32
    pub registered_at: i64,      // 8
    pub cumulative_volume: u64,  // 8
    pub has_claimed: bool,       // 1
}

impl ParticipantState {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct ClaimRecord {
    pub competition: Pubkey, // 32
    pub user: Pubkey,        // 32
    pub claimed_at: i64,     // 8
    pub amount: u64,         // 8
    pub rank: u32,           // 4
    pub has_claimed: bool,   // 1
}

impl ClaimRecord {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 4 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CompetitionInitializedEvent {
    pub competition_id: u64,
    pub admin: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    pub reward_mint: Pubkey,
}

#[event]
pub struct ParticipantRegisteredEvent {
    pub competition_id: u64,
    pub user: Pubkey,
    pub registered_at: i64,
}

#[event]
pub struct PrizePoolFundedEvent {
    pub competition_id: u64,
    pub funder: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct CompetitionFinalizedEvent {
    pub competition_id: u64,
    pub merkle_root: [u8; 32],
    pub finalized_at: i64,
}

#[event]
pub struct PrizeClaimedEvent {
    pub competition_id: u64,
    pub user: Pubkey,
    pub rank: u32,
    pub amount: u64,
}

#[error_code]
pub enum CompetitionError {
    #[msg("Competition name exceeds 32 byte limitation.")]
    NameTooLong,
    #[msg("Start timestamp must be strictly prior to end timestamp.")]
    InvalidTimeRange,
    #[msg("Competition end timestamp is in the past.")]
    CompetitionAlreadyEnded,
    #[msg("Competition is already finalized.")]
    CompetitionFinalized,
    #[msg("Competition has not concluded yet.")]
    CompetitionStillActive,
    #[msg("Competition is not finalized yet.")]
    CompetitionNotFinalized,
    #[msg("Arithmetic overflow detected.")]
    ArithmeticOverflow,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Invalid reward mint provided.")]
    InvalidRewardMint,
    #[msg("Invalid escrow vault provided.")]
    InvalidEscrowVault,
    #[msg("Signer is not authorized to submit final Merkle root.")]
    UnauthorizedKeeper,
    #[msg("Provided Merkle root cannot be empty.")]
    InvalidMerkleRoot,
    #[msg("Participant has already claimed their prize.")]
    AlreadyClaimed,
    #[msg("Cryptographic Merkle proof verification failed.")]
    InvalidMerkleProof,
    #[msg("Destination token account is not owned by the claim signer.")]
    InvalidTokenOwner,
}