import { createServer, type Server } from "node:http";

export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}
