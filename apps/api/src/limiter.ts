import type { Redis } from "ioredis";

export interface FailureLimiter {
  /** Records one auth failure for this key and reports whether the key is over the limit. */
  recordFailure(key: string): Promise<{ limited: boolean; retryAfterSeconds: number }>;
}

/**
 * Fixed-window failed-auth counter shared across API instances via Redis. Only failures count,
 * so valid requests (including from shared NATs) never touch Redis. Fails open if Redis is down.
 */
export function createFailureLimiter(
  redis: Redis,
  options: { limit: number; windowSeconds: number; onError: (err: unknown) => void },
): FailureLimiter {
  return {
    async recordFailure(key) {
      try {
        const redisKey = `authfail:${key}`;
        // One atomic MULTI so a crash can't leave a counter without a TTL (a permanent block).
        const results = await redis
          .multi()
          .set(redisKey, 0, "EX", options.windowSeconds, "NX")
          .incr(redisKey)
          .ttl(redisKey)
          .exec();
        const count = Number(results?.[1]?.[1]);
        const ttl = Number(results?.[2]?.[1]);
        return {
          limited: count > options.limit,
          retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds,
        };
      } catch (err) {
        options.onError(err);
        return { limited: false, retryAfterSeconds: 0 };
      }
    },
  };
}
