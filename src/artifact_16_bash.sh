# 1. Build Smart Contract
anchor build

# 2. Deploy Program to Solana Devnet / Mainnet-Beta
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ./deployer-keypair.json \
  target/deploy/nectarpulse_competition.so

# 3. Initialize Competition Vault & Parameters via Anchor CLI
npx ts-node scripts/initialize-competition.ts \
  --competition-id 1 \
  --entry-fee 100000000 \
  --oracle <ORACLE_PUBKEY> \
  --duration-hours 168