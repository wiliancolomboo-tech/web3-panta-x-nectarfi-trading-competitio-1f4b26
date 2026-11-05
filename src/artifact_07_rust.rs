use anchor_lang::prelude::*;

pub const COMPETITION_SEED: &[u8] = b"competition";
pub const PARTICIPANT_SEED: &[u8] = b"participant";
pub const VAULT_SEED: &[u8] = b"reward_vault";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CompetitionStatus {
    Pending,
    Active,
    Ended,
    Finalized,
}

#[account]
pub struct Competition {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub competition_id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub min_stake_bond: u64,
    pub total_reward_amount: u64,
    pub total_registered_participants: u64,
    pub total_qualifying_volume: u128,
    pub status: CompetitionStatus,
    pub merkle_root: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

impl Competition {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        32 + // oracle_authority
        32 + // reward_mint
        32 + // vault
        8 +  // competition_id
        8 +  // start_ts
        8 +  // end_ts
        8 +  // min_stake_bond
        8 +  // total_reward_amount
        8 +  // total_registered_participants
        16 + // total_qualifying_volume
        1 +  // status enum
        32 + // merkle_root
        1 +  // bump
        1;   // vault_bump
}

#[account]
pub struct Participant {
    pub trader: Pubkey,
    pub competition_id: u64,
    pub registered_at: i64,
    pub stake_bond: u64,
    pub qualifying_volume: u64,
    pub realized_pnl: i64,
    pub nectar_vault_points: u64,
    pub raw_score: u128,
    pub rejected_wash_volume: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl Participant {
    pub const LEN: usize = 8 + // discriminator
        32 + // trader
        8 +  // competition_id
        8 +  // registered_at
        8 +  // stake_bond
        8 +  // qualifying_volume
        8 +  // realized_pnl
        8 +  // nectar_vault_points
        16 + // raw_score
        8 +  // rejected_wash_volume
        1 +  // claimed
        1;   // bump
}