use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("PantaNectarC1ash11111111111111111111111111");

#[program]
pub mod panta_nectar_clash {
    use super::*;

    pub fn initialize_competition(
        ctx: Context<InitializeCompetition>,
        competition_id: u64,
        start_ts: i64,
        end_ts: i64,
        min_stake_bond: u64,
        total_reward_amount: u64,
    ) -> Result<()> {
        instructions::initialize_competition::handler(
            ctx,
            competition_id,
            start_ts,
            end_ts,
            min_stake_bond,
            total_reward_amount,
        )
    }

    pub fn register_participant(
        ctx: Context<RegisterParticipant>,
        competition_id: u64,
    ) -> Result<()> {
        instructions::register_participant::handler(ctx, competition_id)
    }

    pub fn update_metrics(
        ctx: Context<UpdateMetrics>,
        competition_id: u64,
        incremental_volume: u64,
        incremental_pnl: i64,
        nectar_lp_points: u64,
        is_wash_trade: bool,
    ) -> Result<()> {
        instructions::update_metrics::handler(
            ctx,
            competition_id,
            incremental_volume,
            incremental_pnl,
            nectar_lp_points,
            is_wash_trade,
        )
    }

    pub fn finalize_competition(
        ctx: Context<FinalizeCompetition>,
        competition_id: u64,
        merkle_root: [u8; 32],
    ) -> Result<()> {
        instructions::claim_reward::finalize_handler(ctx, competition_id, merkle_root)
    }

    pub fn claim_reward(
        ctx: Context<ClaimReward>,
        competition_id: u64,
        reward_amount: u64,
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::claim_reward::claim_handler(
            ctx,
            competition_id,
            reward_amount,
            merkle_proof,
        )
    }
}