import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AntiWashValidator } from './antiWash';
import { OmnichannelNotifier } from './notifications';
import { buildCompetitionTree, WinnerLeaf } from './merkle';
import * as dotenv from 'dotenv';
dotenv.config();

async function runWorker() {
  console.log("⚡ Starting Panta x NectarFi Ingestion & Verification Daemon");

  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const connection = new Connection(rpcUrl, "confirmed");
  const validator = new AntiWashValidator();
  const notifier = new OmnichannelNotifier();

  console.log(`Connected to Solana RPC: ${rpcUrl}`);

  // Mock sample fills stream
  const sampleFills = [
    { slot: 100, timestamp: Date.now(), trader: "4Nd1m111111111111111111111111111111111111111", counterparty: "4Nd1m111111111111111111111111111111111111111", market: "SOL-USDC", sizeUsd: 10000, isMaker: false },
    { slot: 101, timestamp: Date.now(), trader: "7Y4vP211111111111111111111111111111111111111", counterparty: "9K2qZ111111111111111111111111111111111111111", market: "PANTA-USDC", sizeUsd: 25000, isMaker: true },
  ];

  for (const fill of sampleFills) {
    const verdict = validator.evaluateTrade(fill);
    if (!verdict.isValid) {
      console.warn(`[Anti-Wash]: Rejected fill from ${fill.trader} | Reason: ${verdict.reason}`);
    } else {
      console.log(`[Anti-Wash]: Fill verified for ${fill.trader} of $${fill.sizeUsd}`);
    }
  }

  // Periodic Leaderboard Broadcast
  await notifier.broadcastLeaderboardUpdate([
    { address: "7Y4vP211111111111111111111111111111111111111", score: 94250, rank: 1 },
    { address: "8K1vQ211111111111111111111111111111111111111", score: 71200, rank: 2 },
  ]);

  console.log("Telemetry cycle executed successfully.");
}

runWorker().catch(console.error);