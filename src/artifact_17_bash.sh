# 1. Build Anchor Program
anchor build

# 2. Get Program ID and sync keys
solana address -k target/deploy/panta_nectar_competition-keypair.json
# Replace declare_id!() in lib.rs with the generated pubkey, then rebuild:
anchor build

# 3. Deploy to Solana Devnet
solana program deploy \
  --program-id target/deploy/panta_nectar_competition-keypair.json \
  target/deploy/panta_nectar_competition.so \
  --url https://api.devnet.solana.com

# 4. Run Anchor Tests
anchor test --skip-local-validator