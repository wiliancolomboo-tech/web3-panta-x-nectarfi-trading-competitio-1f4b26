# 1. Build optimized program binary with Anchor
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/panta_nectar_competition-keypair.json \
  target/deploy/panta_nectar_competition.so \
  --url-url https://api.devnet.solana.com

# 3. Verify on-chain deployment
solana program show PNTAnect11111111111111111111111111111111111