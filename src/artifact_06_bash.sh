# Configure RPC endpoint
solana config set --url https://api.devnet.solana.com

# Deploy Program
solana program deploy \
  --program-id target/deploy/panta_nectar_arena-keypair.json \
  target/deploy/panta_nectar_arena.so