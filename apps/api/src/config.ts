import { assertSecretLength, parseSigningKeys, type SigningKey } from "./tool-token.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
};

const int = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

export interface Config {
  port: number;
  issuer: string;
  jwksUrl: string;
  audiences: string[];
  databaseUrl: string;
  redisUrl: string;
  authFailLimit: number;
  authFailWindowSeconds: number;
  maxOrgsPerUser: number;
  invitationTtlHours: number;
  maxPendingInvitationsPerOrg: number;
  maxInvitationsPerOrgPerDay: number;
  maxMembersPerOrg: number;
  /** Public address of the web app, used in invitation emails. */
  webUrl: string;
  /** SMTP server for invitation email; unset disables sending (emails wait in the outbox). */
  smtpUrl: string | undefined;
  emailFrom: string;
  emailMaxAttempts: number;
  emailPollSeconds: number;
  /** Object storage for SBOM uploads; unset disables the SBOM routes (503). */
  sbomStorage:
    { endpoint: string; bucket: string; accessKey: string; secretKey: string } | undefined;
  /** Local development only: create the bucket, its CORS rule and the topic at startup. */
  sbomDevBootstrap: boolean;
  sbomMaxBytes: number;
  sbomUploadTtlSeconds: number;
  sbomMaxPendingPerProject: number;
  /** Kafka-API brokers; unset disables publishing `sbom.uploaded` (events wait in the outbox). */
  kafkaBootstrap: string[] | undefined;
  sbomRelayPollSeconds: number;
  sbomSweepSeconds: number;
  investigationModelId: string;
  investigationMaxPendingPerOrg: number;
  investigationRelayPollSeconds: number;
  /** Internal listener the intelligence worker's tools call (ADR 0009). Never a public interface. */
  investigationTools: {
    host: string;
    port: number;
    /** Static bearer secret shared with the worker. */
    serviceToken: string;
    signingKeys: SigningKey[];
  };
  /** Fastify `trustProxy` value; unset means use the socket address and ignore X-Forwarded-For. */
  trustedProxies: string[] | false;
}

function toolServiceToken(): string {
  const token = required("INTELLIGENCE_TOOL_TOKEN");
  assertSecretLength("INTELLIGENCE_TOOL_TOKEN", token);
  return token;
}

export function loadConfig(): Config {
  const issuer = required("ZITADEL_ISSUER");
  return {
    port: int("PORT", 4000),
    issuer,
    jwksUrl: process.env["JWKS_URL"] ?? `${issuer}/oauth/v2/keys`,
    audiences: required("AUTH_AUDIENCES").split(","),
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    authFailLimit: int("AUTH_FAIL_LIMIT", 10),
    authFailWindowSeconds: int("AUTH_FAIL_WINDOW_SECONDS", 60),
    maxOrgsPerUser: int("MAX_ORGS_PER_USER", 5),
    invitationTtlHours: int("INVITATION_TTL_HOURS", 168),
    maxPendingInvitationsPerOrg: int("MAX_PENDING_INVITATIONS_PER_ORG", 50),
    maxInvitationsPerOrgPerDay: int("MAX_INVITATIONS_PER_ORG_PER_DAY", 50),
    maxMembersPerOrg: int("MAX_MEMBERS_PER_ORG", 100),
    webUrl: process.env["WEB_URL"] ?? "http://localhost:3000",
    smtpUrl: process.env["SMTP_URL"] || undefined,
    emailFrom: process.env["EMAIL_FROM"] ?? "Sentra <no-reply@sentra.local>",
    emailMaxAttempts: int("EMAIL_MAX_ATTEMPTS", 5),
    emailPollSeconds: int("EMAIL_POLL_SECONDS", 5),
    sbomStorage: process.env["S3_ENDPOINT"]
      ? {
          endpoint: process.env["S3_ENDPOINT"],
          bucket: process.env["S3_BUCKET"] ?? "sentra-raw",
          accessKey: required("S3_ACCESS_KEY"),
          secretKey: required("S3_SECRET_KEY"),
        }
      : undefined,
    sbomDevBootstrap: process.env["SBOM_DEV_BOOTSTRAP"] === "1",
    sbomMaxBytes: int("SBOM_MAX_BYTES", 10 * 1024 * 1024),
    sbomUploadTtlSeconds: int("SBOM_UPLOAD_TTL_SECONDS", 15 * 60),
    sbomMaxPendingPerProject: int("SBOM_MAX_PENDING_PER_PROJECT", 10),
    kafkaBootstrap: process.env["KAFKA_BOOTSTRAP"]?.split(","),
    sbomRelayPollSeconds: int("SBOM_RELAY_POLL_SECONDS", 2),
    sbomSweepSeconds: int("SBOM_SWEEP_SECONDS", 60),
    investigationModelId: process.env["INVESTIGATION_MODEL_ID"] ?? "Qwen 3.8:27b",
    investigationMaxPendingPerOrg: int("INVESTIGATION_MAX_PENDING_PER_ORG", 5),
    investigationRelayPollSeconds: int("INVESTIGATION_RELAY_POLL_SECONDS", 2),
    investigationTools: {
      host: process.env["INVESTIGATION_TOOLS_HOST"] ?? "127.0.0.1",
      port: int("INVESTIGATION_TOOLS_PORT", 4001),
      serviceToken: toolServiceToken(),
      signingKeys: parseSigningKeys(required("INVESTIGATION_TOOL_SIGNING_KEYS")),
    },
    trustedProxies: process.env["TRUSTED_PROXIES"]
      ? process.env["TRUSTED_PROXIES"].split(",")
      : false,
  };
}
