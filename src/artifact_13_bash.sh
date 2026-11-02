# ==============================================================================
# 1. BUILD & DEPLOY THE ANCHOR PROGRAM
# ==============================================================================
# Set your local keypair to the deployment authority
solana config set --url https://api.mainnet-beta.solana.com --keypair ./deployer-keypair.json

# Build the Anchor program with deterministic verifiable build
anchor build --verifiable

# Deploy the program to Solana Mainnet-Beta
solana program deploy ./target/deploy/panta_nectar_arena.so \
  --program-id PrtA111111111111111111111111111111111111111

# ==============================================================================
# 2. CONFIGURE ENVIRONMENT SECRETS
# ==============================================================================
cat <<EOF > .env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PROGRAM_ID=PrtA111111111111111111111111111111111111111
COMPETITION_ID=1
RESEND_API_KEY=re_prod_XXXXXXXXXXXXXXXXXXXX
DISCORD_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
ADMIN_KEYPAIR_PATH=./admin-keypair.json
EOF

# ==============================================================================
# 3. INITIALIZE COMPETITION & FUND PRIZE POOL
# ==============================================================================
# Initialize Competition instance (starts immediately, ends in 7 days)
npm run start -- --init --duration-days 7 --min-volume 1000

# Fund reward vault PDA with 50,000 SPL tokens
npm run start -- --fund --amount 50000000000

# ==============================================================================
# 4. LAUNCH CONTAINERIZED CRANK
# ==============================================================================
docker compose up -d --build
docker compose logs -f