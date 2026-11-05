# 1. Build & Deploy Smart Contract on Solana Mainnet/Devnet
anchor build
solana program deploy \
  --program-id target/deploy/panta_nectar_competition-keypair.json \
  target/deploy/panta_nectar_competition.so \
  --url mainnet-beta

# 2. Transfer Upgrade Authority to Multi-Sig (Squads)
solana program set-upgrade-authority PNTAnect11111111111111111111111111111111111 \
  --new-upgrade-authority <SQUADS_MULTISIG_VAULT_ADDRESS>

# 3. Boot Turnkey Keeper Service via Docker Compose
cp .env.example .env
# Populate DISCORD_WEBHOOK_URL and RESEND_API_KEY in .env
docker compose up -d --build

# 4. Verify Telemetry & Service Logs
docker logs -f panta-nectar-keeper