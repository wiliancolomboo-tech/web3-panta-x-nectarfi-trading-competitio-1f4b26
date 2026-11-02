docker compose exec postgres pg_dump \
  -U nectarrank nectarrank > backup.sql

cat backup.sql | docker compose exec -T postgres \
  psql -U nectarrank -d nectarrank