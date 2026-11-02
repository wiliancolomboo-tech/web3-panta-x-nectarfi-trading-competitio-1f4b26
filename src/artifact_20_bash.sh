mkdir -p secrets
solana-keygen new --no-bip39-passphrase -o secrets/keeper-key.json
export KEEPER_PUBKEY=$(solana-keygen pubkey secrets/keeper-key.json)

# Airdrop devnet SOL for keeper rent & transaction fees
solana airdrop 2 $KEEPER_PUBKEY --url devnet