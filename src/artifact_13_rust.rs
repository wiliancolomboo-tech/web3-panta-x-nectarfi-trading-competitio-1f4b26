use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("PntNctR111111111111111111111111111111111111");

#[program]
pub mod panta_nectar_competition {
    use super::*;

    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_ts: i64,
        end_ts: i64,
        min_trade_size: u64,
        prize_pool_amount: u64,
        prize_splits_bps: [u16; 3],
    ) -> Result<()> {
        instructions::initialize_competition::handler(
            ctx,
            competition_id,
            start_ts,
            end_ts,
            min_trade_size,
            prize_pool_amount,
            prize_splits_bps,
        )
    }

    pub fn register_trader(ctx: Context<RegisterTrader>) -> Result<()> {
        instructions::register_trader::handler(ctx)
    }

    pub fn record_trade(
        ctx: Context<RecordTrade>,
        trade_volume: u64,
        realized_pnl: i64,
    ) -> Result<()> {
        instructions::record_trade::handler(ctx, trade_volume, realized_pnl)
    }

    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        winners: [Pubkey; 3],
    ) -> Result<()> {
        instructions::finalize_competition::handler(ctx, winners)
    }

    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        instructions::claim_prize::handler(ctx)
    }
}