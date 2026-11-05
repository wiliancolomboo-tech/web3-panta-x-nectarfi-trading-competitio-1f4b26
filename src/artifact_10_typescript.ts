import express from "express";

const app = express();
const PORT = process.env.PORT || 8080;

app.get("/healthz", async (req, res) => {
  try {
    const slot = await connection.getSlot("processed");
    res.status(200).json({
      status: "healthy",
      svm_slot: slot,
      uptime_seconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(503).json({ status: "unhealthy", reason: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Telemetry endpoint active on :${PORT}/healthz`);
});