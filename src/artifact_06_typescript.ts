import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BN } from "@coral-xyz/anchor";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { Resend } from "resend";
import axios from "axios";
import pino from "pino";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true }
  }
});

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY;
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "PNEcmp9999999999999999999999999999999999999");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!ORACLE_PRIVATE_KEY) {
  logger.error("FATAL: ORACLE_PRIVATE_KEY environment variable is missing.");
  process.exit(1);
}

const oracleKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(ORACLE_PRIVATE_KEY))
);
const connection = new Connection(RPC_URL, "confirmed");
const wallet = new Wallet(oracleKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

// Load IDL
const idlRaw = fs.readFileSync("./target/idl/pne_competition.json", "utf8");
const idl: Idl = JSON.parse(idlRaw);
const program = new Program(idl, PROGRAM_ID, provider);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

interface TraderState {
  pubkey: PublicKey;
  volume: number;
  pnl: number;
  score: number;
  isNectarLp: boolean;
  email?: string;
}

export class CompetitionEngine {
  private competitionPda: PublicKey;
  private traders: Map<string, TraderState> = new Map();
  private currentSequenceId: number = 0;

  constructor(competitionPda: PublicKey) {
    this.competitionPda = competitionPda;
  }

  public async startPipeline() {
    logger.info(`Starting Panta x NectarFi Ingestion Pipeline for Competition: ${this.competitionPda.toBase58()}`);

    // Poll and ingest synthetic trading events
    setInterval(async () => {
      try {
        await this.syncPantaAndNectarEvents();
        await this.broadcastLeaderboard();
      } catch (err) {
        logger.error({ err }, "Error running ingestion interval");
      }
    }, 15000);
  }

  /**
   * Simulates processing confirmed swaps from Panta liquidity pools
   * and cross-referencing NectarFi structured vault deposits.
   */
  public async syncPantaAndNectarEvents() {
    logger.info("Ingesting stream from Solana Yellowstone/RPC...");
    this.currentSequenceId += 1;

    // Example simulated trader event
    const sampleTrader = Keypair.generate().publicKey;
    const traderKey = sampleTrader.toBase58();

    if (!this.traders.has(traderKey)) {
      this.traders.set(traderKey, {
        pubkey: sampleTrader,
        volume: 0,
        pnl: 0,
        score: 0,
        isNectarLp: Math.random() > 0.5,
        email: "trader.winner@example.com"
      });
    }

    const traderData = this.traders.get(traderKey)!;
    const deltaVolume = Math.floor(Math.random() * 50_000_000_000); // in token lamports
    const deltaPnl = Math.floor((Math.random() - 0.3) * 5_000_000_000); // weighted positive

    traderData.volume += deltaVolume;
    traderData.pnl += deltaPnl;
    const nectarMultiplier = traderData.isNectarLp ? 1.25 : 1.0;
    traderData.score = Math.floor((traderData.volume + Math.max(0, traderData.pnl)) * nectarMultiplier);

    logger.info(
      `Trader ${traderKey.slice(0, 8)}... Volume: +${deltaVolume}, PnL: ${deltaPnl}, LP Boost: ${traderData.isNectarLp}`
    );
  }

  public async broadcastLeaderboard() {
    const sorted = Array.from(this.traders.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (sorted.length === 0) return;

    logger.info("Top Trader Score: " + sorted[0].score);

    if (DISCORD_WEBHOOK_URL) {
      const fields = sorted.map((t, idx) => ({
        name: `#${idx + 1} - ${t.pubkey.toBase58().slice(0, 6)}...${t.pubkey.toBase58().slice(-4)}`,
        value: `Score: **${t.score.toLocaleString()}** | Vol: $${(t.volume / 1e6).toFixed(2)} | Nectar Booster: ${t.isNectarLp ? "✅ 1.25x" : "❌ None"}`,
        inline: false
      }));

      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [{
          title: "🏆 Panta x NectarFi Live Trading Competition Standings",
          color: 0xffaa00,
          fields,
          footer: { text: "Verified on Solana by PNE-Core" },
          timestamp: new Date().toISOString()
        }]
      }).catch(err => logger.warn(`Failed to dispatch Discord webhook: ${err.message}`));
    }
  }

  /**
   * Finalizes the tournament, calculates Merkle leaves, publishes the root on-chain,
   * and emails winners using Resend.
   */
  public async finalizeEpoch(payoutTable: { [pubkeyStr: string]: number }) {
    logger.info("Finalizing Competition: Constructing Merkle Allocation Tree");

    const elements = Object.entries(payoutTable).map(([pubkeyStr, amount]) => {
      const pubkey = new PublicKey(pubkeyStr);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(BigInt(amount));
      return Buffer.concat([keccak256(Buffer.concat([pubkey.toBuffer(), amountBuffer]))]);
    });

    const merkleTree = new MerkleTree(elements, keccak256, { sortPairs: true });
    const root = merkleTree.getRoot();

    logger.info(`Calculated Merkle Root: 0x${root.toString("hex")}`);

    // Commit Merkle root on-chain
    const tx = await program.methods
      .finalizeCompetition(Array.from(root))
      .accounts({
        competition: this.competitionPda,
        authority: oracleKeypair.publicKey
      })
      .signers([oracleKeypair])
      .rpc();

    logger.info(`Finalization Tx Confirmed: ${tx}`);

    // Dispatch Resend transactional notifications to top traders
    if (resend) {
      for (const [traderPubkey, rewardAmount] of Object.entries(payoutTable)) {
        const traderObj = this.traders.get(traderPubkey);
        if (traderObj && traderObj.email) {
          try {
            await resend.emails.send({
              from: "competitions@nectarfi.com",
              to: traderObj.email,
              subject: "🎉 You Won the Panta x NectarFi Trading Competition!",
              html: `
                <h2>Congratulations Trader!</h2>
                <p>Your address <code>${traderPubkey}</code> ranked in the winning tier.</p>
                <p>Allocated Prize: <strong>${rewardAmount / 1e6} USDC</strong></p>
                <p>Your cryptographic Merkle proof is indexed. Claim directly through the dApp portal.</p>
              `
            });
            logger.info(`Claim notification sent to ${traderObj.email}`);
          } catch (e: any) {
            logger.error(`Resend failed for ${traderObj.email}: ${e.message}`);
          }
        }
      }
    }

    return { root, merkleTree };
  }
}

// Direct Execution Hook
if (require.main === module) {
  const [competitionIdStr] = process.argv.slice(2);
  const compId = new BN(competitionIdStr || "1");
  const [competitionPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("competition"), compId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  const engine = new CompetitionEngine(competitionPda);
  engine.startPipeline().catch(console.error);
}