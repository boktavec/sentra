import * as client from "openid-client";
import { config } from "./config.ts";

export { client };

let discovered: Promise<client.Configuration> | undefined;

/** Cached OIDC discovery. A failed discovery is not cached so the next request retries. */
export function oidcConfig(): Promise<client.Configuration> {
  const { issuer, clientId, clientSecret, secureCookies } = config();
  discovered ??= client
    .discovery(new URL(issuer), clientId, clientSecret, undefined, {
      // Local Zitadel runs over http; production (https) keeps the library's HTTPS-only default.
      execute: secureCookies ? [] : [client.allowInsecureRequests],
    })
    .catch((err) => {
      discovered = undefined;
      throw err;
    });
  return discovered;
}
