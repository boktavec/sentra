// Idempotent local Zitadel setup for Sentra. Run via `task stack:bootstrap`.
// Reads the bootstrap machine user's PAT from the compose volume, configures the
// instance, and writes app credentials to the gitignored .env.sentra.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ISSUER = `http://${env.ZITADEL_DOMAIN}:${env.ZITADEL_EXTERNALPORT}`;
const WEB_URL = process.env.SENTRA_WEB_URL ?? "http://localhost:3000";
const OUT = ".env.sentra";

const pat = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    "sentra_zitadel-bootstrap:/b:ro",
    "alpine:3.22",
    "cat",
    "/b/admin.pat",
  ],
  { encoding: "utf8" },
).trim();

const toJson = (body) =>
  body === undefined ? undefined : JSON.stringify(body);
const fromJson = (text) => (text ? JSON.parse(text) : {});

// Zitadel answers a no-op update with 400 ("No changes" / "has not been changed" / "NotChanged");
// that is success for an idempotent script.
const isNoOp = (res, text) =>
  res.status === 400 && /no changes|not been changed|not ?changed/i.test(text);

const isAccepted = (res, text, allow) =>
  res.ok || isNoOp(res, text) || allow.includes(res.status);

async function call(method, path, body, { allow = [] } = {}) {
  const res = await fetch(`${ISSUER}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: toJson(body),
  });
  const text = await res.text();
  if (!isAccepted(res, text, allow)) {
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return { status: res.status, json: fromJson(text) };
}

const nameQuery = (name) => ({
  queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
});

// Project
let { json } = await call(
  "POST",
  "/management/v1/projects/_search",
  nameQuery("Sentra"),
);
let projectId = json.result?.[0]?.id;
if (!projectId) {
  ({ json } = await call("POST", "/management/v1/projects", {
    name: "Sentra",
  }));
  projectId = json.id;
}

// Web OIDC app: code + PKCE, JWT access tokens, confidential (Next.js server holds the secret)
const appConfig = {
  redirectUris: [`${WEB_URL}/auth/callback`],
  postLogoutRedirectUris: [WEB_URL],
  responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
  grantTypes: [
    "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
    "OIDC_GRANT_TYPE_REFRESH_TOKEN",
  ],
  appType: "OIDC_APP_TYPE_WEB",
  authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
  accessTokenType: "OIDC_TOKEN_TYPE_JWT",
  devMode: true, // local only: allows http redirect URIs
};
({ json } = await call(
  "POST",
  `/management/v1/projects/${projectId}/apps/_search`,
  nameQuery("sentra-web"),
));
let appId = json.result?.[0]?.id;
let clientId = json.result?.[0]?.oidcConfig?.clientId;
let clientSecret;
if (!appId) {
  ({ json } = await call(
    "POST",
    `/management/v1/projects/${projectId}/apps/oidc`,
    {
      name: "sentra-web",
      ...appConfig,
    },
  ));
  ({ appId, clientId, clientSecret } = json);
} else {
  await call(
    "PUT",
    `/management/v1/projects/${projectId}/apps/${appId}/oidc_config`,
    appConfig,
  );
  const previous = existsSync(OUT)
    ? readFileSync(OUT, "utf8").match(/^ZITADEL_CLIENT_SECRET=(.+)$/m)
    : null;
  if (previous) {
    clientSecret = previous[1];
  } else {
    ({ json } = await call(
      "POST",
      `/management/v1/projects/${projectId}/apps/${appId}/oidc_config/_generate_client_secret`,
      {},
    ));
    clientSecret = json.clientSecret;
  }
}

// Token lifetimes: 10 min access/ID token, ~10 h idle refresh (spec assumption)
await call("PUT", "/admin/v1/settings/oidc", {
  accessTokenLifetime: "600s",
  idTokenLifetime: "600s",
  refreshTokenIdleExpiration: "36000s",
  refreshTokenExpiration: "86400s",
});

// Login policy: self-registration on, password sign-in, optional TOTP MFA (not forced)
await call("PUT", "/admin/v1/policies/login", {
  allowUsernamePassword: true,
  allowRegister: true,
  allowExternalIdp: false,
  forceMfa: false,
  forceMfaLocalOnly: false,
  passwordlessType: "PASSWORDLESS_TYPE_NOT_ALLOWED",
  hidePasswordReset: false,
  ignoreUnknownUsernames: true,
  defaultRedirectUri: WEB_URL,
});
await call(
  "POST",
  "/admin/v1/policies/login/second_factors",
  { type: "SECOND_FACTOR_TYPE_OTP" },
  { allow: [409] },
);

// Password lockout: Zitadel handles guessing; the API limiter covers token abuse
await call("PUT", "/admin/v1/policies/password/lockout", {
  maxPasswordAttempts: 5,
  maxOtpAttempts: 5,
});

// Email: Mailpit as the SMTP sink (verification emails readable at the Mailpit UI)
await call("PUT", "/admin/v1/policies/domain", {
  userLoginMustBeDomain: false,
  validateOrgDomains: false,
  smtpSenderAddressMatchesInstanceDomain: false,
});
({ json } = await call("POST", "/admin/v1/smtp/_search", {}));
let smtp = json.result?.find((c) => c.description === "sentra-mailpit");
if (!smtp) {
  ({ json } = await call("POST", "/admin/v1/smtp", {
    description: "sentra-mailpit",
    senderAddress: "no-reply@sentra.local",
    senderName: "Sentra",
    host: "mailpit:1025",
    tls: false,
  }));
  smtp = { id: json.id };
}
await call(
  "POST",
  `/admin/v1/smtp/${smtp.id}/_activate`,
  {},
  { allow: [400, 412] },
);

// Test-only machine user: lets integration tests obtain real Zitadel-signed JWTs
// (client credentials grant) without driving the browser login.
({ json } = await call("POST", "/management/v1/users/_search", {
  queries: [
    {
      userNameQuery: {
        userName: "sentra-test",
        method: "TEXT_QUERY_METHOD_EQUALS",
      },
    },
  ],
}));
let testUserId = json.result?.[0]?.id;
if (!testUserId) {
  ({ json } = await call("POST", "/management/v1/users/machine", {
    userName: "sentra-test",
    name: "Sentra integration tests",
    accessTokenType: "ACCESS_TOKEN_TYPE_JWT",
  }));
  testUserId = json.userId;
}
({ json } = await call("PUT", `/management/v1/users/${testUserId}/secret`, {}));
const testClientId = json.clientId;
const testClientSecret = json.clientSecret;

// SENTRA-18 secrets are not Zitadel's, so a re-bootstrap must not drop them. Keep the shared tool token from
// .env (the worker reads it there) or the previous .env.sentra; generate only when neither has one.
const previous = existsSync(OUT)
  ? Object.fromEntries(
      readFileSync(OUT, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    )
  : {};
const generated = () => randomBytes(32).toString("base64");
const toolToken =
  env.INTELLIGENCE_TOOL_TOKEN || previous.INTELLIGENCE_TOOL_TOKEN || generated();
const signingKeys =
  previous.INVESTIGATION_TOOL_SIGNING_KEYS || `k1:${generated()}`;

writeFileSync(
  OUT,
  [
    `ZITADEL_ISSUER=${ISSUER}`,
    `ZITADEL_PROJECT_ID=${projectId}`,
    // Tokens carry the issuing client ID in `aud`; the API accepts only these (test client is dev-only).
    `AUTH_AUDIENCES=${clientId},${testClientId}`,
    `ZITADEL_CLIENT_ID=${clientId}`,
    `ZITADEL_CLIENT_SECRET=${clientSecret}`,
    `ZITADEL_TEST_CLIENT_ID=${testClientId}`,
    `ZITADEL_TEST_CLIENT_SECRET=${testClientSecret}`,
    `REDIS_URL=redis://127.0.0.1:${env.REDIS_PUBLISHED_PORT}`,
    `DATABASE_URL=postgresql://sentra:${env.SENTRA_DB_PASSWORD}@127.0.0.1:${env.SENTRA_DB_PUBLISHED_PORT}/sentra`,
    // Local dev SBOM uploads: the API signs uploads for SeaweedFS and publishes events to Redpanda.
    `S3_ENDPOINT=http://localhost:${env.SEAWEEDFS_S3_PUBLISHED_PORT}`,
    "S3_ACCESS_KEY=sentra-api-dev",
    "S3_SECRET_KEY=sentra-api-dev-secret",
    "SBOM_DEV_BOOTSTRAP=1",
    `KAFKA_BOOTSTRAP=127.0.0.1:${env.REDPANDA_KAFKA_PORT}`,
    // Local dev sends invitation email to Mailpit (read it at http://localhost:${env.MAILPIT_UI_PUBLISHED_PORT}).
    `SMTP_URL=smtp://127.0.0.1:${env.MAILPIT_SMTP_PUBLISHED_PORT}`,
    // Investigation tool listener (SENTRA-18). The worker needs the same INTELLIGENCE_TOOL_TOKEN in .env.
    `INTELLIGENCE_TOOL_TOKEN=${toolToken}`,
    `INVESTIGATION_TOOL_SIGNING_KEYS=${signingKeys}`,
    "",
  ].join("\n"),
);
console.log(
  `Zitadel configured. Wrote ${OUT} (issuer ${ISSUER}, project ${projectId}).`,
);
if (!env.INTELLIGENCE_TOOL_TOKEN) {
  // The worker reads the shared token from .env; write it there rather than printing a secret.
  appendFileSync(".env", `\nINTELLIGENCE_TOOL_TOKEN=${toolToken}\n`);
  console.log("Added INTELLIGENCE_TOOL_TOKEN to .env for the intelligence worker.");
}
