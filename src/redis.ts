import { Redis } from "ioredis";

export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  client.on("error", (err: Error) => {
    console.error("[redis] erreur de connexion :", err.message);
  });
  return client;
}
