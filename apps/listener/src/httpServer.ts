import { createServer, type Server } from "node:http";
import type { SseHub } from "./sseHub.js";

export function startHttpServer(port: number, hub: SseHub): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("\n");

      const remove = hub.addClient({
        write: (chunk) => res.write(chunk),
      });

      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(ping);
        }
      }, 20_000);

      req.on("close", () => {
        clearInterval(ping);
        remove();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port);
  return server;
}
