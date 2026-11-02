import http from "http";

export function initHealthcheckServer(port: number = 8080, getStatus: () => object) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "HEALTHY", timestamp: Date.now(), ...getStatus() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => console.log(`[Healthcheck] Listening on port ${port}`));
}