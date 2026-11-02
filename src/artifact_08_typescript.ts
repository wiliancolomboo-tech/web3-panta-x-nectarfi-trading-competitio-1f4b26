import http from "http";

export function startHealthServer(port: number = 8080, getLatestSlot: () => number) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const slot = getLatestSlot();
      const status = {
        status: "ok",
        uptimeSeconds: process.uptime(),
        latestIndexedSlot: slot,
        timestamp: new Date().toISOString(),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[HEALTH] Health check server listening on :${port}/health`);
  });
}