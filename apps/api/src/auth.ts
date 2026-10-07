import { rateLimited, unauthenticated, type AppError, type Logger } from "@sentra/ts-platform";
import type { FailureLimiter } from "./limiter.ts";
import * as metrics from "./metrics.ts";
import type { AuthUser } from "./users.ts";
import type { Claims } from "./verifier.ts";

interface Deps {
  verify: (token: string) => Promise<Claims>;
  resolveUser: (claims: Claims) => Promise<AuthUser>;
  limiter: FailureLimiter;
}

/** Strict `Bearer <token>` parsing; anything else counts as a missing token. */
function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? "");
  if (!match) throw unauthenticated("missing_token");
  return match[1]!;
}

export function createAuthenticator({ verify, resolveUser, limiter }: Deps) {
  return async function authenticate(
    request: { headers: { authorization?: string }; ip: string },
    log: Logger,
  ): Promise<AuthUser> {
    try {
      const user = await resolveUser(await verify(bearerToken(request.headers.authorization)));
      metrics.inc("auth_outcomes_total", { outcome: "success" });
      log.info({ userId: user.id }, "auth_success");
      return user;
    } catch (err) {
      const reason = (err as AppError).reason ?? "error";
      // Only 401s are client failures worth throttling; dependency outages are not the caller's fault.
      if ((err as AppError).status !== 401) throw err;
      const { limited, retryAfterSeconds } = await limiter.recordFailure(request.ip);
      metrics.inc("auth_outcomes_total", { outcome: limited ? "rate_limited" : reason });
      log.warn({ reason, ip: request.ip, limited }, "auth_failure");
      throw limited ? rateLimited(retryAfterSeconds) : err;
    }
  };
}
