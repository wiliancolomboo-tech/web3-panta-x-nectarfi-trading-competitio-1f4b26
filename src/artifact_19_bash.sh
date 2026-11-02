# Build binary
anchor build

# Get Program Address and synchronize declare_id!
solana-keygen pubkey target/deploy/nectar_panta_arena-keypair.json

# Deploy to Devnet
anchor deploy --provider.cluster devnet --program-keypair target/deploy/nectar_panta_arena-keypair.json