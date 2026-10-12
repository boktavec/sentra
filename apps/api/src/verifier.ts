import { errors, jwtVerify } from "jose";
import { unauthenticated, unavailable } from "@sentra/ts-platform";
import { isString } from "./json.ts";
import { JwksUnavailableError, type JwksCache } from "./jwks.ts";

export interface Claims {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
}

/** Maps a jose failure to a coarse reason for logs and metrics. Never shown to clients. */
function reasonFor(cause: unknown): string {
  if (cause instanceof errors.JWTExpired) return "expired";

  if (cause instanceof errors.JWSSignatureVerificationFailed) return "invalid_signature";

  if (cause instanceof errors.JWKSNoMatchingKey) return "unknown_key";

  if (cause instanceof errors.JWTClaimValidationFailed) {
    if (cause.claim === "iss") return "unknown_issuer";

    if (cause.claim === "aud") return "wrong_audience";
  }

  return "invalid_token";
}

export function createVerifier(options: { issuer: string; audiences: string[]; jwks: JwksCache }) {
  return async function verify(token: string): Promise<Claims> {
    try {
      const { payload } = await jwtVerify(token, options.jwks.getKey, {
        issuer: options.issuer,
        audience: options.audiences,
        algorithms: ["RS256"],
        clockTolerance: 30,
        requiredClaims: ["sub", "exp"],
      });

      const claim = (name: "email" | "name") => {
        const value = payload[name];

        return isString(value) ? value : undefined;
      };

      return {
        issuer: payload.iss!,
        subject: payload.sub!,
        email: claim("email"),
        name: claim("name"),
      };
    } catch (err) {
      if (err instanceof JwksUnavailableError) throw unavailable("jwks_unavailable", err);
      throw unauthenticated(reasonFor(err), err);
    }
  };
}
