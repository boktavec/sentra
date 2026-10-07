import { Redis } from "ioredis";
import { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createAuthenticator } from "./auth.ts";
import type { Config } from "./config.ts";
import { JwksCache } from "./jwks.ts";
import { createFailureLimiter } from "./limiter.ts";
import * as metrics from "./metrics.ts";
import { migrate } from "./migrate.ts";
import { createMemberStore } from "./members.ts";
import { createOrgStore } from "./orgs.ts";
import { createUserStore } from "./users.ts";
import { createVerifier } from "./verifier.ts";

/** Wires the real dependencies. Used by the server and by integration tests. */
export async function createApi(config: Config, logger: Logger) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  await migrate(pool);

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on("error", () => {}); // surfaced per call by the limiter, which fails open

  const jwks = new JwksCache({
    url: config.jwksUrl,
    onRefreshError: (err) => {
      metrics.inc("jwks_refresh_failures_total");
      logger.warn({ err: String(err) }, "jwks_refresh_failed");
    },
  });
  await jwks.warm();

  const limiter = createFailureLimiter(redis, {
    limit: config.authFailLimit,
    windowSeconds: config.authFailWindowSeconds,
    onError: (err) => {
      metrics.inc("rate_limiter_errors_total");
      logger.warn({ err: String(err) }, "rate_limiter_unavailable");
    },
  });

  const authenticate = createAuthenticator({
    verify: createVerifier({ issuer: config.issuer, audiences: config.audiences, jwks }),
    resolveUser: createUserStore(pool).resolve,
    limiter,
  });

  const app = buildApp({
    logger,
    authenticate,
    orgs: createOrgStore(pool, { maxOrgsPerUser: config.maxOrgsPerUser }),
    members: createMemberStore(pool),
    trustedProxies: config.trustedProxies,
    ready: async () => {
      if (!jwks.ready) return false;
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  });

  return {
    app,
    pool,
    redis,
    async close() {
      await app.close();
      await pool.end();
      redis.disconnect();
    },
  };
}
