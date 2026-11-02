# 1. Clone repository and install dependencies
git clone https://github.com/nectarfi-panta/ptc-competition-core.git
cd ptc-competition-core
yarn install

# 2. Build on-chain Solana Program with reproducible Verifiable Anchor Build
anchor build --verifiable

# 3. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.mainnet-beta.solana.com
solana program deploy ./target/deploy/ptc_core.so \
  --program-id ./target/deploy/ptc_core-keypair.json \
  --upgrade-authority ./authority-keypair.json

# 4. Initialize Master Competition
yarn ts-node scripts/admin-init-competition.ts \
  --id 101 \
  --durationDays 14 \
  --rewardMint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --initialPrizePool 50000000000