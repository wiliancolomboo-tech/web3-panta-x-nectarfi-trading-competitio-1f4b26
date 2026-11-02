# 1. Build and verify Anchor smart contract
anchor build
solana-keygen new -o target/deploy/panta_nectar_competition-keypair.json --no-bip39-passphrase --force
solana program deploy --program-id target/deploy/panta_nectar_competition-keypair.json target/deploy/panta_nectar_competition.so

# 2. Run local integration tests
anchor test --skip-local-validator

# 3. Configure environment variables for Keeper daemon
cp .env.example .env