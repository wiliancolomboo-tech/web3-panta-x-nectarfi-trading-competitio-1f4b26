use anchor_lang::prelude::*;

#[error_code]
pub enum CompetitionError {
    #[msg("Invalid timestamps: start timestamp must be before end timestamp.")]
    InvalidTimeBounds,
    #[msg("Competition has not started yet.")]
    CompetitionNotStarted,
    #[msg("Competition has already concluded.")]
    CompetitionEnded,
    #[msg("Competition is not finalized yet.")]
    CompetitionNotFinalized,
    #[msg("Competition is already finalized.")]
    CompetitionAlreadyFinalized,
    #[msg("Unauthorized oracle or administrative authority.")]
    Unauthorized,
    #[msg("Participant is already registered for this competition.")]
    ParticipantAlreadyRegistered,
    #[msg("Wash trade detected: trade rejected from volume/score calculation.")]
    WashTradeDetected,
    #[msg("Invalid Merkle proof provided for reward settlement.")]
    InvalidMerkleProof,
    #[msg("Reward has already been claimed by participant.")]
    RewardAlreadyClaimed,
    #[msg("Insufficient escrow vault balance.")]
    InsufficientVaultBalance,
    #[msg("Arithmetic overflow or underflow detected.")]
    MathOverflow,
}