# Generate program deploy keypair
solana-keygen new -o target/deploy/panta_nectar_arena-keypair.json --no-bip39-passphrase --force

# Sync program ID with source code
anchor keys sync

# Build optimized binary
anchor build --verifiable