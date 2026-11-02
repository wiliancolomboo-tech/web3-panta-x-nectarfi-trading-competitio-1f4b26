# 1. Clone repository & install dependencies
git clone https://github.com/nectar-fi/panta-arena.git
cd panta-arena
yarn install

# 2. Build on-chain Anchor program
anchor build

# 3. Synchronize program ID across source code and Anchor.toml
solana address -k target/deploy/panta_nectar_arena-keypair.json
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Initialize the competition epoch via CLI
anchor run init-competition -- --network devnet --id 101 --duration 604800