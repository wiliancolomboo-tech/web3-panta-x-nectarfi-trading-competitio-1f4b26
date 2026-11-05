# 1. Build Solana bytecode
   anchor build

   # 2. Synchronize Program Keys
   anchor keys sync

   # 3. Deploy to Solana Cluster
   solana program deploy \
     --url https://api.mainnet-beta.solana.com \
     --program-id target/deploy/panta_nectar_competition-keypair.json \
     target/deploy/panta_nectar_competition.so