solana config set --url https://api.mainnet-beta.solana.com
anchor build
anchor deploy --provider.cluster mainnet
docker compose up -d --build
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz