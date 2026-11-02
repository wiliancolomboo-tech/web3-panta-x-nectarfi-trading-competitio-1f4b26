use anchor_lang::prelude::*;

#[error_code]
pub enum CompetitionError {
    #[msg("Invalid timestamps: start must be before end, and in the future")]
    InvalidTimestamps,
    #[msg("Competition is not currently active")]
    CompetitionNotActive,
    #[msg("Competition has already concluded")]
    CompetitionEnded,
    #[msg("Competition has not yet concluded")]
    CompetitionNotEnded,
    #[msg("Competition has already been finalized")]
    AlreadyFinalized,
    #[msg("Competition is not yet finalized")]
    NotFinalized,
    #[msg("Trade volume below minimum qualified threshold")]
    TradeVolumeBelowMinimum,
    #[msg("Prize has already been claimed")]
    PrizeAlreadyClaimed,
    #[msg("Invalid Merkle proof provided for prize redemption")]
    InvalidMerkleProof,
    #[msg("Numerical overflow encountered")]
    MathOverflow,
    #[msg("Unauthorized signer for this instruction")]
    Unauthorized,
}