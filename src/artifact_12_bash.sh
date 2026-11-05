# 1. Build and verify Anchor smart contract
cd programs/panta-nectar-arena
cargo build-sbf

# 2. Deploy to Solana Devnet or Mainnet-Beta
solana program deploy \
  --program-id target/deploy/panta_nectar_arena-keypair.json \
  target/deploy/panta_nectar_arena.so \
  --url https://api.devnet.solana.com

# 3. Setup client environment
cd ../../client
cp .env.example .env
# Populate AUTHORITY_SECRET_KEY, RESEND_API_KEY, and DISCORD_WEBHOOK_URL

# 4. Run automated test suite with full assertions
anchor test

# 5. Spin up containerized daemon for continuous indexing and Merkle roots
docker compose up -d --build
docker compose logs -f arena-engine