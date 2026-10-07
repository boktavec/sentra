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
  /** Fastify `trustProxy` value; unset means use the socket address and ignore X-Forwarded-For. */
  trustedProxies: string[] | false;
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
    trustedProxies: process.env["TRUSTED_PROXIES"]
      ? process.env["TRUSTED_PROXIES"].split(",")
      : false,
  };
}
