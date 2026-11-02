import http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HEALTH_PORT, () => {
  console.log(`[HEALTH] Telemetry ping bound to port ${HEALTH_PORT}`);
});