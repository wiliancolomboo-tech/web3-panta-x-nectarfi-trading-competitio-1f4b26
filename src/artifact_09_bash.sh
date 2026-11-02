# Build verified program binary
anchor build

# Get program ID
solana address -k target/deploy/panta_nectar_competition-keypair.json

# Deploy to Solana Mainnet-Beta
anchor deploy --provider.cluster mainnet --program-keypair target/deploy/panta_nectar_competition-keypair.json