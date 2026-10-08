import { Redis } from "ioredis";
import { createTransport } from "nodemailer";
import { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createAuthenticator } from "./auth.ts";
import type { Config } from "./config.ts";
import { JwksCache } from "./jwks.ts";
import { createFailureLimiter } from "./limiter.ts";
import * as metrics from "./metrics.ts";
import { migrate } from "./migrate.ts";
import { createEmailSender } from "./email-sender.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createProfileFetcher } from "./profile.ts";
import { createUserStore } from "./users.ts";
import { createVerifier } from "./verifier.ts";

function startEmailSender(smtpUrl: string, config: Config, pool: Pool, logger: Logger) {
  const sender = createEmailSender(pool, {
    transport: createTransport({
      url: smtpUrl,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10_000,
    }),
    from: config.emailFrom,
    logger,
    maxAttempts: config.emailMaxAttempts,
    leaseSeconds: 60,
    backoffBaseSeconds: 30,
  });
  sender.start(config.emailPollSeconds * 1000);
  return sender;
}

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
    projects: createProjectStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: createProfileFetcher(config.issuer),
      webUrl: config.webUrl,
      limits: {
        ttlHours: config.invitationTtlHours,
        maxPending: config.maxPendingInvitationsPerOrg,
        maxPerDay: config.maxInvitationsPerOrgPerDay,
        maxMembers: config.maxMembersPerOrg,
      },
    }),
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

  // ponytail: in-process sender, safe across replicas (SKIP LOCKED); move to a worker if sending load grows.
  const sender = config.smtpUrl
    ? startEmailSender(config.smtpUrl, config, pool, logger)
    : undefined;
  if (!sender) logger.warn({}, "email_disabled_no_smtp_url");

  return {
    app,
    pool,
    redis,
    async close() {
      await sender?.stop();
      await app.close();
      await pool.end();
      redis.disconnect();
    },
  };
}
