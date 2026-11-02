import express from "express";
import { CONFIG } from "./config";
import { CompetitionIndexer } from "./indexer";
import { MerkleTreeEngine, WinnerEntry } from "./merkle";
import { PublicKey } from "@solana/web3.js";

const app = express();
app.use(express.json());

const indexer = new CompetitionIndexer();

// Healthcheck endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    competitionId: CONFIG.COMPETITION_ID.toString(),
    timestamp: new Date().toISOString(),
  });
});

// Current Leaderboard Endpoint
app.get("/api/leaderboard", (req, res) => {
  const leaderboard = indexer.getLeaderboard().map((p, index) => ({
    rank: index + 1,
    pubkey: p.pubkey,
    volumeUsd: p.volumeUsd.toString(),
    pnlUsd: p.pnlUsd.toString(),
    tradesCount: p.tradesCount,
  }));
  res.json({ leaderboard });
});

// Merkle Root Preview / Generation Endpoint
app.post("/api/merkle/generate", (req, res) => {
  const leaderboard = indexer.getLeaderboard();
  const prizePool = [10_000_000_000n, 5_000_000_000n, 2_500_000_000n]; // 10k, 5k, 2.5k USDC (6 dec)

  const entries: WinnerEntry[] = leaderboard.slice(0, 3).map((p, idx) => ({
    trader: new PublicKey(p.pubkey),
    rank: idx + 1,
    prizeAmount: prizePool[idx] || 0n,
  }));

  if (entries.length === 0) {
    return res.status(400).json({ error: "No active participants recorded." });
  }

  const merkleEngine = new MerkleTreeEngine(entries);
  const root = merkleEngine.getRoot().toString("hex");

  const proofs = entries.map((entry, idx) => ({
    trader: entry.trader.toBase58(),
    rank: entry.rank,
    prizeAmount: entry.prizeAmount.toString(),
    proof: merkleEngine.getProof(idx).map((p) => p.toString("hex")),
  }));

  res.json({
    merkleRoot: `0x${root}`,
    winners: proofs,
  });
});

app.listen(CONFIG.HTTP_PORT, () => {
  console.log(`[PTE Service] Enterprise worker online on port ${CONFIG.HTTP_PORT}`);
  indexer.start().catch((err) => {
    console.error("[Indexer Error]", err);
  });
});