import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import client from "prom-client";
import crypto from "crypto";

dotenv.config();

// Telemetry & Metrics setup
const app = express();
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const tradesProcessedCounter = new client.Counter({
  name: "arena_trades_processed_total",
  help: "Total trade attestations committed on-chain",
  labelNames: ["status"],
});
register.registerMetric(tradesProcessedCounter);

// Configurations
const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY!;
const PROGRAM_ID = new PublicKey(
  process.env.ARENA_PROGRAM_ID || "PArtNd8zV8hZ7mNzg6a7Z4R2R2jL4s9xHqB7d1vKpUm"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COMPETITION_ID = new BN(process.env.COMPETITION_ID || "101");

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Initialize Keypair & Provider
const oracleKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(ORACLE_PRIVATE_KEY))
);
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  wsEndpoint: RPC_URL.replace("https://", "wss://").replace("http://", "ws://"),
});
const wallet = new Wallet(oracleKeypair);
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
});

interface TradePayload {
  competitor: string;
  volumeUsdc: number; // raw units (e.g. 100_000_000 for 100 USDC)
  pnlDelta: number;
  txSignature: string;
  sourceVenue: "PantaDEX" | "NectarFiVault";
}

class ArenaIntegrationWorker {
  private program: Program<any> | null = null;

  async init() {
    console.log("[Worker] Bootstrapping Panta x NectarFi Arena Worker...");
    console.log(`[Worker] Oracle Public Key: ${oracleKeypair.publicKey.toBase58()}`);
    console.log(`[Worker] Connected to RPC: ${RPC_URL}`);

    // In production, the IDL is loaded from the anchor artifacts or fetched via AnchorProvider
    const idl = await Program.fetchIdl(PROGRAM_ID, provider);
    if (!idl) {
      throw new Error(`Failed to load IDL for Program ID ${PROGRAM_ID.toBase58()}`);
    }
    this.program = new Program(idl, provider);
    console.log("[Worker] Program successfully attached.");
  }

  /**
   * Derives competition state PDA
   */
  getCompetitionPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), COMPETITION_ID.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );
  }

  /**
   * Derives competitor profile PDA
   */
  getCompetitorProfilePDA(competitor: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("competitor"),
        COMPETITION_ID.toArrayLike(Buffer, "le", 8),
        competitor.toBuffer(),
      ],
      PROGRAM_ID
    );
  }

  /**
   * Derives trade receipt PDA to enforce replay protection
   */
  getTradeReceiptPDA(tradeHash: Buffer): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), tradeHash],
      PROGRAM_ID
    );
  }

  /**
   * Ingest and verify trade execution; commits attestation to Solana
   */
  async processAndAttestTrade(payload: TradePayload): Promise<string> {
    if (!this.program) throw new Error("Worker not initialized");

    const competitorPubkey = new PublicKey(payload.competitor);
    const [competitionPDA] = this.getCompetitionPDA();
    const [profilePDA] = this.getCompetitorProfilePDA(competitorPubkey);

    // Compute canonical 32-byte sha256 trade hash
    const tradeHash = crypto
      .createHash("sha256")
      .update(`${payload.txSignature}-${payload.competitor}-${payload.volumeUsdc}`)
      .digest();

    const [receiptPDA] = this.getTradeReceiptPDA(tradeHash);
    const timestamp = Math.floor(Date.now() / 1000);

    console.log(`[Worker] Attesting trade ${payload.txSignature} from ${payload.sourceVenue}...`);

    try {
      const tx = await this.program.methods
        .recordVerifiedTrade(
          Array.from(tradeHash),
          new BN(payload.volumeUsdc),
          new BN(payload.pnlDelta),
          new BN(timestamp)
        )
        .accounts({
          competition: competitionPDA,
          competitorProfile: profilePDA,
          tradeReceipt: receiptPDA,
          oracleAuthority: oracleKeypair.publicKey,
          systemProgram: PublicKey.default,
        })
        .signers([oracleKeypair])
        .rpc();

      console.log(`[Worker] Trade confirmed on Solana! Tx: ${tx}`);
      tradesProcessedCounter.inc({ status: "success" });

      // Notify telemetry endpoints
      await this.dispatchLeaderboardNotification(payload, tx);
      return tx;
    } catch (err: any) {
      console.error(`[Worker] Error recording trade: ${err.message}`);
      tradesProcessedCounter.inc({ status: "failure" });
      throw err;
    }
  }

  /**
   * Dispatches alerts to Discord and Resend Enterprise Email
   */
  async dispatchLeaderboardNotification(payload: TradePayload, txHash: string) {
    const formattedVolume = (payload.volumeUsdc / 1e6).toFixed(2);
    const formattedPnl = (payload.pnlDelta / 1e6).toFixed(2);

    // 1. Post to Discord/Slack Webhook
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: "⚡ Verified Trade Attested | Panta x NectarFi Arena",
              color: 0x00ff88,
              fields: [
                { name: "Venue", value: payload.sourceVenue, inline: true },
                {
                  name: "Competitor",
                  value: `\`${payload.competitor.slice(0, 4)}...${payload.competitor.slice(-4)}\``,
                  inline: true,
                },
                { name: "Volume (USDC)", value: `$${formattedVolume}`, inline: true },
                { name: "Realized PnL", value: `$${formattedPnl}`, inline: true },
                {
                  name: "Solana Explorer",
                  value: `[View Transaction](https://explorer.solana.com/tx/${txHash}?cluster=devnet)`,
                },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } catch (err: any) {
        console.error(`[Alert] Discord dispatch failed: ${err.message}`);
      }
    }

    // 2. Dispatch Enterprise Email via Resend if significant volume ($10,000+)
    if (resend && payload.volumeUsdc >= 10_000 * 1e6 && process.env.ADMIN_ALERT_EMAIL) {
      try {
        await resend.emails.send({
          from: "arena-alerts@nectarfi.exchange",
          to: process.env.ADMIN_ALERT_EMAIL,
          subject: `🐋 Whale Trade Attested: $${formattedVolume} USDC on ${payload.sourceVenue}`,
          html: `
            <h2>Panta x NectarFi Arena Event</h2>
            <p>A major competition volume event was verified and anchored to Solana consensus.</p>
            <ul>
              <li><strong>Competitor:</strong> ${payload.competitor}</li>
              <li><strong>Volume:</strong> $${formattedVolume} USDC</li>
              <li><strong>Realized PnL:</strong> $${formattedPnl} USDC</li>
              <li><strong>Solana Tx:</strong> ${txHash}</li>
            </ul>
          `,
        });
      } catch (err: any) {
        console.error(`[Alert] Resend email dispatch failed: ${err.message}`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// HTTP & METRICS SERVER
// -----------------------------------------------------------------------------
const worker = new ArenaIntegrationWorker();

app.use(express.json());

// Prometheus Metrics Scrape Endpoint
app.get("/metrics", async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

// Liveness / Readiness Healthcheck
app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy", timestamp: Date.now() });
});

// Ingest webhook endpoint for Panta/NectarFi off-chain trade matchers
app.post("/api/v1/trade-webhook", async (req: Request, res: Response) => {
  try {
    const payload = req.body as TradePayload;
    if (!payload.competitor || !payload.txSignature || !payload.volumeUsdc) {
      return res.status(400).json({ error: "Missing required payload parameters" });
    }
    const signature = await worker.processAndAttestTrade(payload);
    return res.status(200).json({ success: true, solanaTx: signature });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`[Server] Metrics and Webhook server online on port ${PORT}`);
  await worker.init();
});