import { unavailable } from "@sentra/ts-platform";
import { isString } from "./json.ts";

export interface Profile {
  email?: string;
  emailVerified: boolean;
  name?: string;
}

/** Looks up the signed-in user's profile with their own access token. */
export type ProfileFetcher = (accessToken: string) => Promise<Profile>;

/** The OIDC userinfo claims this API reads; the endpoint is trusted for identity but not for field types. */
interface Userinfo {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

/**
 * Zitadel access tokens carry no email or name, so the verified email comes from the OIDC userinfo
 * endpoint. A failure is a 503 for the caller to retry, never a guess.
 */
export function createProfileFetcher(issuer: string): ProfileFetcher {
  return async (accessToken) => {
    try {
      const res = await fetch(`${issuer}/oidc/v1/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) throw new Error(`userinfo returned ${res.status}`);
      const body: Userinfo = await res.json();

      const { email, name } = body;

      return {
        email: isString(email) && email ? email.toLowerCase() : undefined,
        emailVerified: body.email_verified === true,
        name: isString(name) && name ? name : undefined,
      };
    } catch (err) {
      throw unavailable("profile_fetch_failed", err);
    }
  };
}
