# Set Solana cluster target
solana config set --url https://api.devnet.solana.com

# Build optimized BPF bytecode
anchor build

# Deploy Program
anchor deploy --program-name panta_nectar_competition --program-keypair target/deploy/panta_nectar_competition-keypair.json