# Copy and configure production secrets
cp .env.example .env
nano .env

# Launch self-healing container
docker compose up -d --build

# Verify real-time logs & health
docker compose logs -f
curl http://localhost:8080/healthz