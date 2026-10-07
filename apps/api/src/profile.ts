import { unavailable } from "@sentra/ts-platform";

export interface Profile {
  email?: string;
  emailVerified: boolean;
  name?: string;
}

/** Looks up the signed-in user's profile with their own access token. */
export type ProfileFetcher = (accessToken: string) => Promise<Profile>;

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

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
      const body = (await res.json()) as Record<string, unknown>;
      return {
        email: str(body["email"])?.toLowerCase(),
        emailVerified: body["email_verified"] === true,
        name: str(body["name"]),
      };
    } catch (err) {
      throw unavailable("profile_fetch_failed", err);
    }
  };
}
