import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { keccak_256 } from "js-sha3";
import axios from "axios";
import { Resend } from "resend";
import * as fs from "fs";

export interface TraderStats {
  address: string;
  volume: number;
  pnl: number;
  tradesCount: number;
  email?: string;
}

export interface PrizeAllocation {
  index: number;
  address: string;
  amount: bigint;
  proof: string[];
}

export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(elements: Buffer[]) {
    this.leaves = elements.slice().sort(Buffer.compare);
    this.layers = [this.leaves];
    this.buildTree();
  }

  private hashPair(a: Buffer, b: Buffer): Buffer {
    return Buffer.compare(a, b) <= 0
      ? Buffer.from(keccak_256.arrayBuffer(Buffer.concat([a, b])))
      : Buffer.from(keccak_256.arrayBuffer(Buffer.concat([b, a])));
  }

  private buildTree() {
    let currentLayer = this.leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Buffer[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(this.hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  public getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0] || Buffer.alloc(32);
  }

  public getProof(leaf: Buffer): Buffer[] {
    const proof: Buffer[] = [];
    let index = -1;
    for (let i = 0; i < this.leaves.length; i++) {
      if (this.leaves[i].equals(leaf)) {
        index = i;
        break;
      }
    }
    if (index === -1) return proof;

    for (let layerIndex = 0; layerIndex < this.layers.length - 1; layerIndex++) {
      const layer = this.layers[layerIndex];
      const isRightNode = index % 2 === 1;
      const pairIndex = isRightNode ? index - 1 : index + 1;
      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }
}

export class EnterpriseCompetitionWorker {
  private connection: Connection;
  private authority: Keypair;
  private resend: Resend;
  private discordWebhookUrl: string;
  private slackWebhookUrl: string;

  constructor(
    rpcUrl: string,
    authorityKeypairPath: string,
    resendApiKey: string,
    discordWebhookUrl: string,
    slackWebhookUrl: string
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    const rawKey = JSON.parse(fs.readFileSync(authorityKeypairPath, "utf-8"));
    this.authority = Keypair.fromSecretKey(new Uint8Array(rawKey));
    this.resend = new Resend(resendApiKey);
    this.discordWebhookUrl = discordWebhookUrl;
    this.slackWebhookUrl = slackWebhookUrl;
  }

  public generateLeaf(index: number, trader: PublicKey, amount: bigint): Buffer {
    const bufIndex = Buffer.alloc(4);
    bufIndex.writeUInt32LE(index, 0);

    const bufAmount = Buffer.alloc(8);
    bufAmount.writeBigUInt64LE(amount, 0);

    const packed = Buffer.concat([bufIndex, trader.toBuffer(), bufAmount]);
    return Buffer.from(keccak_256.arrayBuffer(packed));
  }

  public async broadcastLeaderboardUpdate(topTraders: TraderStats[], epochId: number) {
    const leaderboardFields = topTraders.slice(0, 5).map((t, idx) => ({
      name: `#${idx + 1} | ${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      value: `**Volume:** $${t.volume.toLocaleString()} | **PnL:** $${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}`,
      inline: false,
    }));

    // Enterprise Discord Dispatch
    if (this.discordWebhookUrl) {
      await axios.post(this.discordWebhookUrl, {
        embeds: [
          {
            title: `🏆 Panta x NectarFi Epoch #${epochId} Leaderboard Update`,
            color: 0x00f5a0,
            fields: leaderboardFields,
            timestamp: new Date().toISOString(),
            footer: { text: "Verified Solana On-Chain Metrics" },
          },
        ],
      }).catch((err) => console.error("Discord Webhook Error:", err.message));
    }

    // Enterprise Slack Ops Dispatch
    if (this.slackWebhookUrl) {
      await axios.post(this.slackWebhookUrl, {
        text: `*Panta x NectarFi Competition Epoch #${epochId} Status*\nTop Trader Volume: $${topTraders[0]?.volume.toLocaleString() ?? 0}`,
      }).catch((err) => console.error("Slack Webhook Error:", err.message));
    }
  }

  public async notifyWinnerViaResend(
    email: string,
    traderPubkey: string,
    rank: number,
    prizeAmount: string,
    claimUrl: string
  ) {
    try {
      await this.resend.emails.send({
        from: "competitions@nectarfi.io",
        to: email,
        subject: `🎉 Congratulations! You Placed #${rank} in Panta x NectarFi Competition`,
        html: `
          <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px;">
            <h1 style="color: #00f5a0;">You Won in Panta x NectarFi!</h1>
            <p>Trader Account: <code>${traderPubkey}</code></p>
            <p>Final Standing: <strong>Rank #${rank}</strong></p>
            <p>Your Allocated Prize: <strong>${prizeAmount} SPL</strong></p>
            <hr style="border: 1px solid #1a2230; margin: 20px 0;" />
            <p>Your cryptographic claim receipt is confirmed on Solana. Claim your funds instantly:</p>
            <a href="${claimUrl}" style="background-color: #00f5a0; color: #000; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Claim Prize On-Chain</a>
          </div>
        `,
      });
      console.log(`[Resend] Winner email dispatched to ${email}`);
    } catch (e: any) {
      console.error(`[Resend] Failed to send email to ${email}:`, e.message);
    }
  }
}