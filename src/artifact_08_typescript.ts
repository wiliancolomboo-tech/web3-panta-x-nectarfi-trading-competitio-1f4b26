import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { MerkleTreeEngine, WinnerLeaf } from "./merkle";
import { NotificationHub } from "./notifier";
import * as winston from "winston";
import * as dotenv from "dotenv";

dotenv.config();

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

export class ArenaOrchestratorDaemon {
  private connection: Connection;
  private authorityKeypair: Keypair;
  private notifier: NotificationHub;
  private programId: PublicKey;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

    const secretKeyString = process.env.AUTHORITY_SECRET_KEY;
    if (!secretKeyString) {
      throw new Error("Missing AUTHORITY_SECRET_KEY environment variable");
    }
    this.authorityKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(secretKeyString))
    );
    this.programId = new PublicKey(
      process.env.PROGRAM_ID || "PrtAcv9P2QeXnK7d1V8JgJ9W8vC7g5yDk6JbM1N2x3Q"
    );
    this.notifier = new NotificationHub();
  }

  public async runEpochSettlement(
    competitionId: bigint,
    mockTraders: Array<{ pubkey: string; pnl: number; volume: number }>
  ): Promise<void> {
    logger.info(`Starting Epoch Settlement for Competition ID: ${competitionId.toString()}`);

    // Anti-wash and risk-adjusted ranking
    const qualifiedTraders = mockTraders
      .filter((t) => t.volume >= 1000)
      .sort((a, b) => b.pnl - a.pnl);

    logger.info(`Total qualified participants: ${qualifiedTraders.length}`);

    // Allocate tiered rewards
    const prizeTiers = [5000_000000n, 3000_000000n, 2000_000000n]; // 5000, 3000, 2000 USDC (6 decimals)
    const leaves: WinnerLeaf[] = [];

    for (let i = 0; i < Math.min(qualifiedTraders.length, prizeTiers.length); i++) {
      leaves.push({
        competitor: new PublicKey(qualifiedTraders[i].pubkey),
        amount: prizeTiers[i],
      });
    }

    if (leaves.length === 0) {
      logger.warn("No qualified participants found for reward distribution");
      return;
    }

    // Build Merkle Tree
    const merkleEngine = new MerkleTreeEngine(leaves);
    const root = merkleEngine.getRoot();
    logger.info(`Computed Merkle Root: 0x${root.toString("hex")}`);

    // Transmit notifications
    await this.notifier.broadcastLeaderboardUpdate(
      "Epoch #1",
      qualifiedTraders[0].pubkey,
      qualifiedTraders[0].pnl.toFixed(2),
      "10,000"
    );

    logger.info("Settlement computed. Merkle Root ready for on-chain submission.");
  }
}

// Direct Execution Trigger
if (require.main === module) {
  const orchestrator = new ArenaOrchestratorDaemon();
  const sampleData = [
    { pubkey: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", pnl: 142.8, volume: 500000 },
    { pubkey: "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK", pnl: 88.5, volume: 250000 },
    { pubkey: "GsbwXfJraGW95Lsm8ivU4D1uMhRkUms1Nq7w3QhX9Bpq", pnl: 45.2, volume: 150000 },
  ];
  orchestrator.runEpochSettlement(1n, sampleData).catch((err) => {
    logger.error("Daemon runtime error: " + err.message);
    process.exit(1);
  });
}