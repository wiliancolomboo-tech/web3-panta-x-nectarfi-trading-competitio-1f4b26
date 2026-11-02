import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  Ed25519Program,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as nacl from "tweetnacl";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration Interfaces
interface Config {
  solanaRpcUrl: string;
  oracleKeypair: Keypair;
  programId: PublicKey;
  competitionPda: PublicKey;
  discordWebhookUrl?: string;
  resendApiKey?: string;
  resendFromEmail?: string;
}

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "NectP11111111111111111111111111111111111111"
);

// Enterprise Event Broadcaster
export class EnterpriseNotificationService {
  constructor(
    private discordWebhook?: string,
    private resendApiKey?: string,
    private fromEmail?: string
  ) {}

  public async broadcastLeaderboardUpdate(
    leader: string,
    volumeUsd: number,
    pnlUsd: number
  ): Promise<void> {
    if (!this.discordWebhook) return;

    try {
      await axios.post(this.discordWebhook, {
        embeds: [
          {
            title: "⚡ Panta x NectarFi Competition Leaderboard Update",
            color: 3066993,
            fields: [
              { name: "Top Trader", value: `\`${leader}\``, inline: false },
              { name: "Attested Volume", value: `$${volumeUsd.toLocaleString()}`, inline: true },
              { name: "Cumulative PnL", value: `$${pnlUsd.toLocaleString()}`, inline: true },
            ],
            footer: { text: "Secured by NectarPulse Cryptographic Oracle" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err: any) {
      console.error("[Notification] Failed to send Discord broadcast:", err.message);
    }
  }

  public async sendWinnerNotification(
    recipientEmail: string,
    rank: number,
    prizeAmount: string
  ): Promise<void> {
    if (!this.resendApiKey || !this.fromEmail) return;

    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: this.fromEmail,
          to: recipientEmail,
          subject: `🏆 You Placed Rank #${rank} in Panta x NectarFi Trading Arena!`,
          html: `
            <h2>Congratulations Trader!</h2>
            <p>Your performance in the Panta x NectarFi Trading Competition has finalized.</p>
            <p><strong>Rank:</strong> #${rank}</p>
            <p><strong>Allocated Prize:</strong> ${prizeAmount} Tokens</p>
            <p>You can now claim your non-custodial prize tranche directly from the NectarPulse Vault.</p>
          `,
        },
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[Resend] Winner email dispatched to ${recipientEmail}`);
    } catch (err: any) {
      console.error("[Notification] Failed to send Resend email:", err.message);
    }
  }
}

// Keeper Oracle Attestation Engine
export class TradeAttestationKeeper {
  private connection: Connection;
  private provider: AnchorProvider;
  private notifier: EnterpriseNotificationService;

  constructor(private config: Config) {
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    const wallet = new Wallet(config.oracleKeypair);
    this.provider = new AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.notifier = new EnterpriseNotificationService(
      config.discordWebhookUrl,
      config.resendApiKey,
      config.resendFromEmail
    );
  }

  /**
   * Encodes trade execution payload, builds ed25519 signature ix, and registers
   * verifiable proof into the Solana Program.
   */
  public async submitTradeAttestation(
    participantPubkey: PublicKey,
    volumeDelta: number,
    pnlDelta: number,
    sequence: number
  ): Promise<string> {
    // 1. Pack deterministic buffer: [CompPubKey(32) | PartPubKey(32) | Volume(8) | PnL(8) | Seq(8)]
    const messageBuffer = Buffer.alloc(32 + 32 + 8 + 8 + 8);
    let offset = 0;

    this.config.competitionPda.toBuffer().copy(messageBuffer, offset);
    offset += 32;
    participantPubkey.toBuffer().copy(messageBuffer, offset);
    offset += 32;

    messageBuffer.writeBigUInt64LE(BigInt(volumeDelta), offset);
    offset += 8;
    messageBuffer.writeBigInt64LE(BigInt(pnlDelta), offset);
    offset += 8;
    messageBuffer.writeBigUInt64LE(BigInt(sequence), offset);

    // 2. Sign cryptographic payload with Oracle Ed25519 secret key
    const signature = nacl.sign.detached(
      messageBuffer,
      this.config.oracleKeypair.secretKey
    );

    // 3. Construct Pre-Instruction: Solana Ed25519 Native Program Verification
    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: this.config.oracleKeypair.publicKey.toBytes(),
      message: messageBuffer,
      signature: signature,
    });

    // 4. Derive participant record PDA
    const [participantRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nectar_participant"),
        this.config.competitionPda.toBuffer(),
        participantPubkey.toBuffer(),
      ],
      this.config.programId
    );

    // 5. Build AttestTrade Instruction Data
    // Instruction Discriminator: sha255("global:attest_trade")[0..8]
    const attestIxData = Buffer.concat([
      Buffer.from([0x26, 0xef, 0x11, 0x4f, 0xc1, 0xa3, 0x1d, 0x90]), // Example discriminator
      messageBuffer.slice(64), // volume(8), pnl(8), sequence(8)
      signature,
    ]);

    const tx = new Transaction().add(ed25519Instruction).add({
      programId: this.config.programId,
      keys: [
        { pubkey: this.config.oracleKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: this.config.competitionPda, isSigner: false, isWritable: false },
        { pubkey: participantRecordPda, isSigner: false, isWritable: true },
        { pubkey: participantPubkey, isSigner: false, isWritable: false },
        { pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data: attestIxData,
    });

    const txHash = await sendAndConfirmTransaction(this.connection, tx, [
      this.config.oracleKeypair,
    ]);

    console.log(`[Attestation Confirmed] Tx Signature: ${txHash}`);

    // Push Telemetry
    await this.notifier.broadcastLeaderboardUpdate(
      participantPubkey.toBase58(),
      volumeDelta,
      pnlDelta
    );

    return txHash;
  }
}

// Self-starting operational daemon
async function main() {
  const secretKey = Uint8Array.from(JSON.parse(process.env.ORACLE_SECRET_KEY || "[]"));
  if (secretKey.length === 0) {
    console.warn("[WARN] Set ORACLE_SECRET_KEY in environment to run the keeper loop.");
    return;
  }

  const keeper = new TradeAttestationKeeper({
    solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    oracleKeypair: Keypair.fromSecretKey(secretKey),
    programId: PROGRAM_ID,
    competitionPda: new PublicKey(process.env.COMPETITION_PDA || PublicKey.default),
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    resendApiKey: process.env.RESEND_API_KEY,
    resendFromEmail: process.env.RESEND_FROM_EMAIL || "competitions@nectarfi.io",
  });

  console.log("🚀 NectarPulse Keeper Automation Daemon active.");
}

if (require.main === module) {
  main().catch(console.error);
}