# 1. Build Solana Anchor Program
anchor build

# 2. Get Program ID and sync keys
solana address -k target/deploy/panta_nectar_competition-keypair.json
anchor keys sync

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/panta_nectar_competition-keypair.json \
  target/deploy/panta_nectar_competition.so \
  --url https://api.devnet.solana.com

# 4. Verify IDL on-chain
anchor idl init --filepath target/idl/panta_nectar_competition.json \
  $(solana address -k target/deploy/panta_nectar_competition-keypair.json) \
  --provider.cluster devnet