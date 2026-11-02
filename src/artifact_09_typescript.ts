// src/server.ts
import express from "express";
import { ArenaOrchestrator } from "./arena-orchestrator";

const app = express();
const port = process.env.PORT || 8080;

const orchestrator = new ArenaOrchestrator({
  rpcUrl: process.env.RPC_URL!,
  keeperKeypairPath: process.env.KEEPER_KEYPAIR_PATH!,
  programId: process.env.PROGRAM_ID!,
  epochId: Number(process.env.EPOCH_ID!),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL!,
  resendApiKey: process.env.RESEND_API_KEY!,
  opsEmail: process.env.OPS_EMAIL!,
});

app.get("/health", async (req, res) => {
  try {
    const health = await orchestrator.runHealthCheck();
    if (!health.ok) {
      return res.status(503).json({
        status: "DEGRADED",
        reason: "Low keeper balance",
        balance: health.balanceSol,
      });
    }
    return res.status(200).json({ status: "HEALTHY", balance: health.balanceSol });
  } catch (err: any) {
    return res.status(500).json({ status: "UNHEALTHY", error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Panta x NectarFi Arena Telemetry Server running on port ${port}`);
});