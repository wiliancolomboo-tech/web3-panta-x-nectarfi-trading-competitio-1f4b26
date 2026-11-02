import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "HEALTHY", uptime: process.uptime(), timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`[HEALTHCHECK] Telemetry server listening on port ${process.env.PORT || 8080}`);
});