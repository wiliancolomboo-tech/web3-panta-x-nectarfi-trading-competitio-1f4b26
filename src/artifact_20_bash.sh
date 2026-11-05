# 1. Build and verify Anchor smart contract
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/panta_nectar_clash-keypair.json \
  target/deploy/panta_nectar_clash.so \
  --url https://api.mainnet-beta.solana.com \
  --fee-payer deployer-wallet.json

# 3. Initialize Competition Genesis
npx ts-node orchestrator/src/admin/initCompetition.ts \
  --competitionId 1 \
  --durationDays 14 \
  --rewardAmount 50000 \
  --rewardMint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v