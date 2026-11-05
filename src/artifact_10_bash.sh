cp .env.example .env
   # Populate SOLANA_RPC_URL, DISCORD_WEBHOOK_URL, RESEND_API_KEY
   docker-compose up -d --build
   docker-compose logs -f sentinel