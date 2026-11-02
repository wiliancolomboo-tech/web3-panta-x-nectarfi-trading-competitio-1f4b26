# Configure Solana CLI to Mainnet / Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2

# Build program binary and generate IDL
anchor build

# Deploy to Solana
anchor deploy --program-name panta_nectar_arena --program-keypair target/deploy/panta_nectar_arena-keypair.json