import { Redis } from "ioredis";
import { config } from "./config.ts";

let client: Redis | undefined;

export function redis(): Redis {
  // Offline queue stays on so the first command waits for the lazy connection instead of failing.
  client ??= new Redis(config().redisUrl, { maxRetriesPerRequest: 1 });
  return client;
}
