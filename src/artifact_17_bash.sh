# 1. Clone repository & install dependencies
git clone https://github.com/panta-nectarfi/pn-trading-competition.git
cd pn-trading-competition
yarn install

# 2. Build on-chain program
anchor build

# 3. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Verify deployment program ID matches declare_id!
anchor keys sync