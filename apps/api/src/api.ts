import { Producer, stringSerializers } from "@platformatic/kafka";
import { Redis } from "ioredis";
import { createTransport } from "nodemailer";
import { Pool } from "pg";
import type { Logger } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createAuditStore } from "./audits.ts";
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
import { createFindingStore } from "./findings.ts";
import { createInvestigationStore } from "./investigations.ts";
import { createInvestigationRelay } from "./investigation-relay.ts";
import { buildInternalApp } from "./investigation-tool-routes.ts";
import { createInvestigationTools } from "./investigation-tools.ts";
import { createProjectStore } from "./projects.ts";
import { createSbomRelay, ensureDevTopic, type EventPublisher } from "./sbom-relay.ts";
import { createSbomStorage } from "./sbom-storage.ts";
import { createSbomStore } from "./sbom.ts";
import { createProfileFetcher } from "./profile.ts";
import { createUserStore } from "./users.ts";
import { loadToolValidators } from "./tool-contracts.ts";
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

function startSbomRelay(brokers: string[], config: Config, pool: Pool, logger: Logger) {
  const producer = new Producer({
    clientId: "sentra-api",
    bootstrapBrokers: brokers,
    serializers: stringSerializers,
  });
  const publisher: EventPublisher = {
    async publish(topic, key, value) {
      await producer.send({ messages: [{ topic, key, value }] });
    },
  };
  const relay = createSbomRelay(pool, {
    publisher,
    logger,
    topic: "sbom.uploaded",
    leaseSeconds: 60,
    backoffBaseSeconds: 5,
  });
  relay.start(config.sbomRelayPollSeconds * 1000);
  return { relay, close: () => producer.close(true) };
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

  const storage = config.sbomStorage ? createSbomStorage(config.sbomStorage) : undefined;
  if (storage && config.sbomDevBootstrap) await storage.ensureDevBucket(config.webUrl);
  const sbom = storage
    ? createSbomStore(pool, {
        storage,
        limits: {
          maxBytes: config.sbomMaxBytes,
          uploadTtlSeconds: config.sbomUploadTtlSeconds,
          maxPendingPerProject: config.sbomMaxPendingPerProject,
        },
      })
    : undefined;
  if (!sbom) logger.warn({}, "sbom_disabled_no_s3_endpoint");

  const app = buildApp({
    logger,
    authenticate,
    orgs: createOrgStore(pool, { maxOrgsPerUser: config.maxOrgsPerUser }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    investigations: createInvestigationStore(pool, {
      modelId: config.investigationModelId,
      maxPendingPerOrg: config.investigationMaxPendingPerOrg,
    }),
    sbom,
    sbomMaxBytes: config.sbomMaxBytes,
    audits: createAuditStore(pool, logger),
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

  const internalApp = buildInternalApp({
    logger,
    serviceToken: config.investigationTools.serviceToken,
    signingKeys: config.investigationTools.signingKeys,
    tools: createInvestigationTools(pool, {
      signingKeys: config.investigationTools.signingKeys,
      validators: loadToolValidators(),
    }),
  });

  // ponytail: in-process sender, safe across replicas (SKIP LOCKED); move to a worker if sending load grows.
  const sender = config.smtpUrl
    ? startEmailSender(config.smtpUrl, config, pool, logger)
    : undefined;
  if (!sender) logger.warn({}, "email_disabled_no_smtp_url");

  // ponytail: in-process relay and sweep, safe across replicas (SKIP LOCKED); move to a worker if load grows.
  if (config.kafkaBootstrap && config.sbomDevBootstrap) {
    await ensureDevTopic(config.kafkaBootstrap, "sbom.uploaded");
    await ensureDevTopic(config.kafkaBootstrap, "investigation.requested");
  }
  const relay = config.kafkaBootstrap
    ? startSbomRelay(config.kafkaBootstrap, config, pool, logger)
    : undefined;
  if (!relay) logger.warn({}, "sbom_relay_disabled_no_kafka_bootstrap");
  const investigationRelay = config.kafkaBootstrap
    ? (() => {
        const producer = new Producer({
          clientId: "sentra-investigation-relay",
          bootstrapBrokers: config.kafkaBootstrap!,
          serializers: stringSerializers,
        });
        const publisher: EventPublisher = {
          async publish(topic, key, value) {
            await producer.send({ messages: [{ topic, key, value }] });
          },
        };
        const poller = createInvestigationRelay(pool, {
          publisher,
          logger,
          leaseSeconds: 60,
          backoffBaseSeconds: 5,
        });
        poller.start(config.investigationRelayPollSeconds * 1000);
        return { poller, close: () => producer.close(true) };
      })()
    : undefined;
  const sweep = sbom
    ? setInterval(() => {
        sbom.expirePending().catch((err: unknown) => {
          metrics.inc("sbom_sweep_errors_total");
          logger.error({ err: String(err) }, "sbom_sweep_error");
        });
      }, config.sbomSweepSeconds * 1000)
    : undefined;
  sweep?.unref();

  return {
    app,
    internalApp,
    sbom,
    relay: relay?.relay,
    investigationRelay: investigationRelay?.poller,
    pool,
    redis,
    async close() {
      clearInterval(sweep);
      await sender?.stop();
      await relay?.relay.stop();
      await relay?.close();
      await investigationRelay?.poller.stop();
      await investigationRelay?.close();
      storage?.destroy();
      await app.close();
      await internalApp.close();
      await pool.end();
      redis.disconnect();
    },
  };
}
