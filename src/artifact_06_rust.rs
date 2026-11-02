use anchor_lang::prelude::*;

#[account]
pub struct Competition {
    pub authority: Pubkey,
    pub competition_id: u64,
    pub reward_mint: Pubkey,
    pub reward_vault: Pubkey,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub entry_fee: u64,
    pub min_trade_size: u64,
    pub total_traders: u64,
    pub total_volume: u64,
    pub total_reward_pool: u64,
    pub merkle_root: [u8; 32],
    pub is_finalized: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Competition {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        8 +  // competition_id
        32 + // reward_mint
        32 + // reward_vault
        8 +  // start_timestamp
        8 +  // end_timestamp
        8 +  // entry_fee
        8 +  // min_trade_size
        8 +  // total_traders
        8 +  // total_volume
        8 +  // total_reward_pool
        32 + // merkle_root
        1 +  // is_finalized
        1 +  // bump
        1 +  // vault_bump
        64;  // padding
}

#[account]
pub struct TraderRecord {
    pub competition: Pubkey,
    pub trader: Pubkey,
    pub registered_timestamp: i64,
    pub cumulative_volume: u64,
    pub cumulative_pnl: i64,
    pub total_trades: u64,
    pub has_claimed: bool,
    pub bump: u8,
}

impl TraderRecord {
    pub const LEN: usize = 8 + // discriminator
        32 + // competition
        32 + // trader
        8 +  // registered_timestamp
        8 +  // cumulative_volume
        8 +  // cumulative_pnl
        8 +  // total_trades
        1 +  // has_claimed
        1 +  // bump
        32;  // padding
}