import http from "http";

export function launchHealthServer(port = 8080) {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "HEALTHY", timestamp: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
}