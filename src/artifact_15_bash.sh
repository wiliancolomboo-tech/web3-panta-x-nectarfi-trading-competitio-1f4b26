# Set Solana Cluster
solana config set --url https://api.mainnet-beta.solana.com

# Build Deterministic Verifiable ELF
anchor build --verifiable

# Deploy to Solana Mainnet
solana program deploy \
  --program-id target/deploy/panta_nectar_competition-keypair.json \
  target/deploy/panta_nectar_competition.so