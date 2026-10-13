# 1. Clone & install dependencies
git clone https://github.com/panta-nectar-bounty/panta-nectar-competition.git
cd panta-nectar-competition
npm install -g @coral-xyz/anchor-cli
npm install

# 2. Build program binary
anchor build

# 3. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Run test suite
anchor test