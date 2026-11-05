# 1. Build and verify Anchor smart contract
anchor build
anchor test

# 2. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url devnet
anchor deploy --program-name panta_nectar_arena --provider.cluster devnet

# 3. Launch automated backend worker & webhooks
cp .env.example .env
# Edit .env with your OPERATOR_PRIVATE_KEY and DISCORD_WEBHOOK_URL
docker-compose up -d --build

# 4. View real-time indexed logs
docker-compose logs -f competition-worker