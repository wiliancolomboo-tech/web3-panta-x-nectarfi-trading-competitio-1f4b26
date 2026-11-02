# Set up initial competition with 10,000 slot duration and anti-wash fee
npx ts-node scripts/init-arena.ts \
  --competition-id 1 \
  --duration-slots 10000 \
  --keeper-pubkey $KEEPER_PUBKEY