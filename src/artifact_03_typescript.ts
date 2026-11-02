import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration Interfaces
interface SystemConfig {
  solanaRpcUrl: string;
  solanaWsUrl: string;
  programId: string;
  competitionId: number;
  oraclePrivateKey: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  slackWebhookUrl?: string;
  leaderboardPollIntervalMs: number;
}

const CONFIG: SystemConfig = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  solanaWsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "PNTAnECTAR1111111111111111111111111111111111",
  competitionId: parseInt(process.env.COMPETITION_ID || "101", 10),
  oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY || "",
  resendApiKey: process.env.RESEND_API_KEY || "re_test_dummy_key",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  leaderboardPollIntervalMs: 5000,
};

// Initialize External Enterprise Clients
const resend = new Resend(CONFIG.resendApiKey);

interface ParticipantCacheEntry {
  trader: string;
  score: number;
  volumeUsd: number;
  pnlUsd: number;
  trades: number;
}

export class PantaNectarCompetitionDaemon {
  private connection: Connection;
  private oracleKeypair: Keypair;
  private programPubkey: PublicKey;
  private competitionPda: PublicKey;
  private memoryLeaderboard: Map<string, ParticipantCacheEntry> = new Map();

  constructor() {
    this.connection = new Connection(CONFIG.solanaRpcUrl, {
      wsEndpoint: CONFIG.solanaWsUrl,
      commitment: "confirmed",
    });

    if (CONFIG.oraclePrivateKey) {
      const secret = Uint8Array.from(JSON.parse(CONFIG.oraclePrivateKey));
      this.oracleKeypair = Keypair.fromSecretKey(secret);
    } else {
      console.warn("⚠️ No ORACLE_PRIVATE_KEY provided. Generating transient keypair for runtime.");
      this.oracleKeypair = Keypair.generate();
    }

    this.programPubkey = new PublicKey(CONFIG.programId);
    
    // Derive Competition PDA: seeds = [b"competition", competition_id.to_le_bytes()]
    const compIdBuffer = Buffer.alloc(8);
    compIdBuffer.writeBigUInt64LE(BigInt(CONFIG.competitionId));
    
    const [compPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), compIdBuffer],
      this.programPubkey
    );
    this.competitionPda = compPda;
  }

  public async start(): Promise<void> {
    console.log("==========================================================");
    console.log("  PANTA x NECTARFI TRADING ARENA - ENTERPRISE INDEXER    ");
    console.log(`  Competition ID : ${CONFIG.competitionId}`);
    console.log(`  Competition PDA: ${this.competitionPda.toBase58()}`);
    console.log(`  Oracle Keypair : ${this.oracleKeypair.publicKey.toBase58()}`);
    console.log("==========================================================");

    await this.verifyHealth();
    this.subscribeProgramLogs();
    this.startLeaderboardBroadcastLoop();
  }

  private async verifyHealth(): Promise<void> {
    const slot = await this.connection.getSlot();
    const balance = await this.connection.getBalance(this.oracleKeypair.publicKey);
    console.log(`[HEALTH] Connected to Solana RPC at slot ${slot}`);
    console.log(`[HEALTH] Oracle Gas Balance: ${balance / 1e9} SOL`);
  }

  /**
   * Subscribes to real-time events emitted by the Arena program
   */
  private subscribeProgramLogs(): void {
    console.log("[SUBSCRIBE] Subscribing to program account transaction stream...");

    this.connection.onLogs(
      this.programPubkey,
      async (logInfo) => {
        if (logInfo.err) return;

        for (const log of logInfo.logs) {
          if (log.includes("TradeRecorded")) {
            await this.handleTradeEvent(log, logInfo.signature);
          } else if (log.includes("PrizeClaimed")) {
            await this.handleClaimEvent(log);
          }
        }
      },
      "confirmed"
    );
  }

  /**
   * Enterprise Webhook Alert: Discord
   */
  public async notifyDiscord(title: string, description: string, fields: Array<{ name: string; value: string; inline?: boolean }>): Promise<void> {
    if (!CONFIG.discordWebhookUrl) return;
    try {
      await axios.post(CONFIG.discordWebhookUrl, {
        embeds: [
          {
            title: `🏆 ${title}`,
            description,
            color: 0x00f5a0, // Nectar Neon Green
            fields,
            footer: { text: "Panta x NectarFi Real-Time Execution Engine" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err: any) {
      console.error("[ALERT_ERROR] Discord notification failed:", err.message);
    }
  }

  /**
   * Enterprise Webhook Alert: Slack (Optional)
   */
  public async notifySlack(text: string): Promise<void> {
    if (!CONFIG.slackWebhookUrl) return;
    try {
      await axios.post(CONFIG.slackWebhookUrl, { text });
    } catch (err: any) {
      console.error("[ALERT_ERROR] Slack notification failed:", err.message);
    }
  }

  /**
   * Transactional Email: Resend Winner Notification
   */
  public async sendWinnerEmail(traderPubkey: string, rank: number, prizeAmountUsdc: string, recipientEmail: string): Promise<void> {
    try {
      const response = await resend.emails.send({
        from: "competitions@nectarfi.com",
        to: recipientEmail,
        subject: `🎉 Congratulations! You Placed #${rank} in the Panta x NectarFi Arena!`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
            <h1 style="color: #00f5a0;">Panta x NectarFi Trading Competition</h1>
            <p>Outstanding performance! Your address <code>${traderPubkey}</code> finished at <strong>Rank #${rank}</strong>.</p>
            <div style="background-color: #1a1f2c; padding: 16px; border-radius: 6px; margin: 20px 0;">
              <p style="margin: 0; font-size: 18px;">Total Prize Entitlement: <strong style="color: #00f5a0;">${prizeAmountUsdc} USDC</strong></p>
            </div>
            <p>Your reward is secured in the on-chain PDA escrow vault. You can execute your trustless claim directly via the UI or by calling <code>claim_prize</code> on Solana.</p>
            <br/>
            <p style="color: #8c9ba5; font-size: 12px;">Automated Settlement Oracle ID: ${this.oracleKeypair.publicKey.toBase58()}</p>
          </div>
        `,
      });
      console.log(`[EMAIL_SENT] Dispatched Resend notification to ${recipientEmail} (ID: ${response.data?.id})`);
    } catch (err: any) {
      console.error("[RESEND_ERROR] Failed to send transactional email:", err.message);
    }
  }

  private async handleTradeEvent(rawLog: string, txSignature: string): Promise<void> {
    console.log(`[TRADE_EVENT] Detected fill on-chain. Signature: ${txSignature}`);
    
    // In production, parse base64 Anchor event data
    await this.notifyDiscord("New High-Value Fill Recorded", "A qualifying trade was recorded in the arena.", [
      { name: "Transaction", value: `[Explorer](https://explorer.solana.com/tx/${txSignature}?cluster=devnet)`, inline: true },
      { name: "Engine", value: "Panta Intent Router", inline: true },
    ]);
  }

  private async handleClaimEvent(rawLog: string): Promise<void> {
    console.log(`[CLAIM_EVENT] Prize claim detected.`);
    await this.notifyDiscord("Prize Escrow Claim Executed", "A winning trader has disbursed rewards to their wallet.", [
      { name: "Status", value: "Settled on-chain", inline: true },
    ]);
  }

  /**
   * Broadcast loop pushing periodic leaderboard updates to community channels
   */
  private startLeaderboardBroadcastLoop(): void {
    setInterval(async () => {
      // Simulate top trader aggregation
      console.log("[METRICS] Polling latest standings and generating digest...");
    }, CONFIG.leaderboardPollIntervalMs);
  }
}

// CLI Launcher
if (require.main === module) {
  const daemon = new PantaNectarCompetitionDaemon();
  daemon.start().catch((err) => {
    console.error("FATAL: Daemon initialization crashed:", err);
    process.exit(1);
  });
}