import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { Resend } from "resend";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// Program Constants
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "PntNctR111111111111111111111111111111111111"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

interface LeaderboardEntry {
  user: PublicKey;
  pnl: anchor.BN;
  volume: anchor.BN;
  score: anchor.BN;
}

export class PantaNectarKeeper {
  private connection: Connection;
  private relayerKeypair: Keypair;
  private provider: anchor.AnchorProvider;
  private program: anchor.Program;

  constructor() {
    this.connection = new Connection(RPC_URL, "confirmed");

    const secretKeyPath = process.env.RELAYER_KEYPAIR_PATH || "./relayer-keypair.json";
    if (fs.existsSync(secretKeyPath)) {
      const secret = JSON.parse(fs.readFileSync(secretKeyPath, "utf-8"));
      this.relayerKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
    } else {
      console.warn("⚠️ Relayer keypair not found. Generating temporary fallback keypair.");
      this.relayerKeypair = Keypair.generate();
    }

    const wallet = new anchor.Wallet(this.relayerKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(this.provider);

    // Minimal ABI IDL definition for runtime keeper orchestration
    const idl = JSON.parse(fs.readFileSync("./target/idl/panta_nectar_competition.json", "utf-8"));
    this.program = new anchor.Program(idl, this.provider);
  }

  public async notifyChannels(title: string, message: string, data?: Record<string, any>) {
    console.log(`[ALERT] ${title} - ${message}`);

    // 1. Dispatch to Discord
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: `🏆 Panta x NectarFi: ${title}`,
              description: message,
              color: 0x00ffa3,
              fields: data
                ? Object.entries(data).map(([name, value]) => ({
                    name,
                    value: String(value),
                    inline: true,
                  }))
                : [],
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } catch (err) {
        console.error("Failed to send Discord webhook:", err);
      }
    }

    // 2. Dispatch to Slack
    if (SLACK_WEBHOOK_URL) {
      try {
        await axios.post(SLACK_WEBHOOK_URL, {
          text: `*Panta x NectarFi Competition Alert*\n*${title}*\n${message}`,
        });
      } catch (err) {
        console.error("Failed to send Slack webhook:", err);
      }
    }

    // 3. Dispatch to Resend Email (Executive Sponsor Handover)
    if (resend && process.env.ALERT_EMAIL_RECIPIENT) {
      try {
        await resend.emails.send({
          from: "competition-daemon@nectarfi.com",
          to: process.env.ALERT_EMAIL_RECIPIENT,
          subject: `[Settlement Event] Panta x NectarFi: ${title}`,
          html: `<p><strong>${title}</strong></p><p>${message}</p><pre>${JSON.stringify(
            data || {},
            null,
            2
          )}</pre>`,
        });
      } catch (err) {
        console.error("Failed to send Resend email:", err);
      }
    }
  }

  public async monitorCompetition(competitionId: anchor.BN) {
    const [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );
    const [leaderboardPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("leaderboard"), competitionPda.toBuffer()],
      PROGRAM_ID
    );

    console.log(`[KEEPER] Monitoring Competition PDA: ${competitionPda.toBase58()}`);

    setInterval(async () => {
      try {
        const compAccount: any = await this.program.account.competitionState.fetch(competitionPda);
        const currentTs = Math.floor(Date.now() / 1000);

        console.log(
          `[STATUS] Comp: ${competitionId.toString()} | Current Time: ${currentTs} | End: ${compAccount.endTs.toString()} | Finalized: ${compAccount.isFinalized}`
        );

        // Epoch Settlement Check
        if (currentTs >= compAccount.endTs.toNumber() && !compAccount.isFinalized) {
          console.log("[KEEPER] Epoch expiry detected. Finalizing competition...");
          const tx = await this.program.methods
            .finalizeCompetition()
            .accounts({
              competition: competitionPda,
              signer: this.relayerKeypair.publicKey,
            })
            .signers([this.relayerKeypair])
            .rpc();

          console.log(`[KEEPER] Competition Finalized Successfully! Tx: ${tx}`);

          const leaderboard: any = await this.program.account.leaderboardState.fetch(leaderboardPda);
          const topWinners = leaderboard.entries.slice(0, 3);

          await this.notifyChannels(
            `Competition #${competitionId.toString()} Settled!`,
            `The epoch has finalized with a total prize pool of ${(
              compAccount.totalPrizePool.toNumber() / 1e6
            ).toFixed(2)} USDC (Yield Amplified via NectarFi).`,
            {
              "1st Place": topWinners[0]?.user.toBase58() || "N/A",
              "2nd Place": topWinners[1]?.user.toBase58() || "N/A",
              "3rd Place": topWinners[2]?.user.toBase58() || "N/A",
              "Tx Signature": tx,
            }
          );
        }
      } catch (err: any) {
        console.error("[KEEPER] Error polling competition state:", err.message);
      }
    }, 15000);
  }
}

// Daemon execution point
if (require.main === module) {
  const keeper = new PantaNectarKeeper();
  const targetCompId = new anchor.BN(process.env.COMPETITION_ID || "101");
  keeper.monitorCompetition(targetCompId).catch(console.error);
}