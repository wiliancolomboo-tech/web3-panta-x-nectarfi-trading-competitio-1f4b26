# 1. Clone repository and install dependencies
git clone https://github.com/panta-nectar-arena/competition-core.git
cd competition-core
npm install -g @coral-xyz/anchor-cli
yarn install

# 2. Build Solana Anchor Program
anchor build

# 3. Synchronize Program ID and Deploy to Solana Devnet / Mainnet
solana address -k target/deploy/panta_nectar_arena-keypair.json
# Ensure Anchor.toml and declare_id!() match the output address
anchor deploy --provider.cluster devnet

# 4. Initialize Competition Vault
yarn ts-node scripts/init-competition.ts \
  --competition-id 101 \
  --prize-amount 10000 \
  --metric hybrid \
  --duration-days 7