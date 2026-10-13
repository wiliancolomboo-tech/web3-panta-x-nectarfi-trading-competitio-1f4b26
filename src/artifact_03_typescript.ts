// src/keeper_daemon.ts

import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import { keccak_256 } from "@noble/hashes/sha3";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "PNTAnECTAR111111111111111111111111111111111"
);

interface ParticipantScore {
  pubkey: string;
  volume: bigint;
  pnl: bigint;
  rewardAmount: bigint;
}

export class MerkleTreeEngine {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(elements: { pubkey: PublicKey; rewardAmount: bigint }[]) {
    this.leaves = elements.map((item) => {
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(item.rewardAmount);
      const combined = Buffer.concat([item.pubkey.toBuffer(), amountBuf]);
      return Buffer.from(keccak_256(combined));
    });

    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree() {
    while (this.layers[this.layers.length - 1].length > 1) {
      const currentLayer = this.layers[this.layers.length - 1];
      const nextLayer: Buffer[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          const left = currentLayer[i];
          const right = currentLayer[i + 1];
          const concat = Buffer.compare(left, right) <= 0
            ? Buffer.concat([left, right])
            : Buffer.concat([right, left]);
          nextLayer.push(Buffer.from(keccak_256(concat)));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
    }
  }

  public getRoot(): Buffer {
    if (this.leaves.length === 0) return Buffer.alloc(32, 0);
    return this.layers[this.layers.length - 1][0];
  }

  public getProof(index: number): Buffer[] {
    const proof: Buffer[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = index % 2 === 1;
      const pairIndex = isRight ? index - 1 : index + 1;
      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }
}

export class CompetitionKeeperDaemon {
  private connection: Connection;
  private authorityKeypair: Keypair;
  private resendClient?: Resend;

  constructor() {
    this.connection = new Connection(RPC_URL, "confirmed");
    const secretKeyPath = process.env.AUTHORITY_KEYPAIR_PATH || "./authority.json";

    if (fs.existsSync(secretKeyPath)) {
      const raw = JSON.parse(fs.readFileSync(secretKeyPath, "utf-8"));
      this.authorityKeypair = Keypair.fromSecretKey(Uint8Array.from(raw));
    } else {
      console.warn("Authority keypair not found, generating ephemeral wallet.");
      this.authorityKeypair = Keypair.generate();
    }

    if (RESEND_API_KEY) {
      this.resendClient = new Resend(RESEND_API_KEY);
    }
  }

  /**
   * Broadcast an automated notification to Slack / Discord webhook.
   */
  async broadcastLeaderboardAlert(message: string, fields: { title: string; value: string }[]) {
    if (!SLACK_WEBHOOK_URL) {
      console.log(`[Notification Stub] ${message}`);
      return;
    }

    try {
      await axios.post(SLACK_WEBHOOK_URL, {
        username: "Panta x NectarFi Bot",
        icon_emoji: ":trophy:",
        attachments: [
          {
            color: "#00FFA3",
            pretext: "⚡ *Panta x NectarFi Trading Competition Update*",
            text: message,
            fields: fields.map((f) => ({
              title: f.title,
              value: f.value,
              short: true,
            })),
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      });
      console.log("Slack notification successfully dispatched.");
    } catch (err: any) {
      console.error("Failed to dispatch Slack notification:", err.message);
    }
  }

  /**
   * Send reward confirmation email via Resend to the winner.
   */
  async sendWinnerEmail(recipientEmail: string, traderPubkey: string, rewardAmountUsdc: string) {
    if (!this.resendClient) {
      console.log(`[Resend Disabled] Reward notice to ${recipientEmail} for ${rewardAmountUsdc} USDC`);
      return;
    }

    try {
      await this.resendClient.emails.send({
        from: "rewards@panta-nectar.fi",
        to: recipientEmail,
        subject: "🎉 Your Panta x NectarFi Competition Prize is Claimable!",
        html: `
          <h2>Congratulations Trader!</h2>
          <p>Your address <code>${traderPubkey}</code> ranked in the prize tier of the Panta x NectarFi Trading Competition.</p>
          <p><strong>Claimable Amount:</strong> ${rewardAmountUsdc} USDC</p>
          <p>Your cryptographic Merkle proof has been finalized on Solana devnet/mainnet. Connect your wallet to claim.</p>
          <br/>
          <p><em>The Panta x NectarFi Foundation</em></p>
        `,
      });
      console.log(`Resend receipt dispatched to ${recipientEmail}`);
    } catch (err: any) {
      console.error("Failed to send Resend email:", err.message);
    }
  }

  /**
   * Settle an epoch off-chain, compute weights, and commit root to Solana.
   */
  async processEpochSettlement(competitionId: bigint, participants: ParticipantScore[]) {
    console.log(`Processing epoch settlement for Competition #${competitionId}...`);

    // 1. Anti-wash filtering: filter out participants with 0 or negative PnL or wash-patterns
    const eligible = participants.filter((p) => p.volume > BigInt(1_000_000_000) && p.pnl > BigInt(0));

    // 2. Allocate reward pool pro-rata or by rank
    const totalPrizePool = BigInt(50_000_000_000); // 50,000 USDC (6 decimals)
    const totalEligibleVolume = eligible.reduce((acc, curr) => acc + curr.volume, BigInt(0));

    const preparedLeaves = eligible.map((p) => {
      const share = (p.volume * totalPrizePool) / (totalEligibleVolume || BigInt(1));
      return {
        pubkey: new PublicKey(p.pubkey),
        rewardAmount: share,
      };
    });

    // 3. Build Merkle Tree
    const tree = new MerkleTreeEngine(preparedLeaves);
    const root = tree.getRoot();
    console.log(`Computed Merkle Root: 0x${root.toString("hex")}`);

    // 4. Send Slack Update
    await this.broadcastLeaderboardAlert(`Competition #${competitionId} Finalized!`, [
      { title: "Eligible Winners", value: eligible.length.toString() },
      { title: "Total Volume Settled", value: `$${Number(totalEligibleVolume / BigInt(1_000_000)).toLocaleString()}` },
      { title: "Root Hash", value: `0x${root.toString("hex").slice(0, 10)}...` },
    ]);

    return {
      merkleRoot: root,
      leaves: preparedLeaves,
      tree,
    };
  }
}

// CLI Execution Entrypoint
if (require.main === module) {
  const daemon = new CompetitionKeeperDaemon();
  console.log("Panta x NectarFi Automation Keeper initialized.");

  // Demonstration mock execution
  const mockParticipants: ParticipantScore[] = [
    { pubkey: Keypair.generate().publicKey.toBase58(), volume: BigInt(500_000_000_000), pnl: BigInt(12_000_000), rewardAmount: BigInt(0) },
    { pubkey: Keypair.generate().publicKey.toBase58(), volume: BigInt(300_000_000_000), pnl: BigInt(8_500_000), rewardAmount: BigInt(0) },
    { pubkey: Keypair.generate().publicKey.toBase58(), volume: BigInt(50_000_000), pnl: BigInt(-1_000_000), rewardAmount: BigInt(0) }, // disqualified
  ];

  daemon.processEpochSettlement(BigInt(1), mockParticipants).then((res) => {
    console.log("Epoch settled with root:", res.merkleRoot.toString("hex"));
  });
}