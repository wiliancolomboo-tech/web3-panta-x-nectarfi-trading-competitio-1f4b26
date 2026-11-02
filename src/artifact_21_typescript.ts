import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG } from "./config";
import { sendDiscordAlert } from "./notifications";

export interface ParticipantScore {
  pubkey: string;
  volumeUsd: bigint;
  pnlUsd: bigint;
  tradesCount: number;
}

export class CompetitionIndexer {
  private connection: Connection;
  private programId: PublicKey;
  private participants: Map<string, ParticipantScore> = new Map();

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      wsEndpoint: CONFIG.SOLANA_WS_URL,
      commitment: "confirmed",
    });
    this.programId = new PublicKey(CONFIG.PROGRAM_ID);
  }

  public async start() {
    console.log(`[Indexer] Subscribing to program logs for: ${this.programId.toBase58()}`);
    this.connection.onLogs(
      this.programId,
      (logs, ctx) => {
        if (logs.err) return;
        this.processLogs(logs.logs, logs.signature);
      },
      "confirmed"
    );
  }

  private processLogs(logs: string[], signature: string) {
    for (const log of logs) {
      if (log.includes("Trade Recorded:")) {
        console.log(`[Indexer] New trade detected: ${signature}`);
        // Extract log patterns
        const match = log.match(/Trader: (.*), Added Volume: \$(\d+), Realized PnL: \$(-?\d+)/);
        if (match) {
          const [, trader, volStr, pnlStr] = match;
          const vol = BigInt(volStr);
          const pnl = BigInt(pnlStr);

          const existing = this.participants.get(trader) || {
            pubkey: trader,
            volumeUsd: 0n,
            pnlUsd: 0n,
            tradesCount: 0,
          };

          existing.volumeUsd += vol;
          existing.pnlUsd += pnl;
          existing.tradesCount += 1;
          this.participants.set(trader, existing);

          if (vol >= 100_000n) {
            sendDiscordAlert("🐋 Whale Execution on Panta Router", `High-volume trade recorded on competition ledger!`, [
              { name: "Trader", value: `\`${trader}\`` },
              { name: "Volume Added", value: `$${vol.toLocaleString()}` },
              { name: "Realized PnL", value: `$${pnl.toLocaleString()}` },
              { name: "Transaction", value: `[SolanaFM](https://solana.fm/tx/${signature})` },
            ]);
          }
        }
      }
    }
  }

  public getLeaderboard(): ParticipantScore[] {
    return Array.from(this.participants.values()).sort((a, b) => {
      if (b.pnlUsd > a.pnlUsd) return 1;
      if (b.pnlUsd < a.pnlUsd) return -1;
      return 0;
    });
  }
}