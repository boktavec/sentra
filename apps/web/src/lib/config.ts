const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
};

/** Read lazily so `next build` doesn't need runtime secrets. */
export const config = () => {
  const webUrl = process.env["WEB_URL"] ?? "http://localhost:3000";
  return {
    webUrl,
    apiUrl: process.env["API_URL"] ?? "http://localhost:4000",
    issuer: required("ZITADEL_ISSUER"),
    clientId: required("ZITADEL_CLIENT_ID"),
    clientSecret: required("ZITADEL_CLIENT_SECRET"),
    redisUrl: required("REDIS_URL"),
    redirectUri: `${webUrl}/auth/callback`,
    secureCookies: webUrl.startsWith("https://"),
    sessionIdleSeconds: Number(process.env["SESSION_IDLE_SECONDS"] ?? 10 * 3600),
  };
};
