import type { Pool } from "pg";
import type { Claims } from "./verifier.ts";

export interface AuthUser {
  id: string;
  issuer: string;
  subject: string;
}

const CACHE_LIMIT = 10_000;

/** Just-in-time user provisioning keyed by (issuer, subject); safe under concurrent first requests. */
export function createUserStore(pool: Pool) {
  // ponytail: unbounded-ish map cleared at the limit; swap for an LRU if churn ever matters.
  const cache = new Map<string, string>();

  return {
    async resolve(claims: Claims): Promise<AuthUser> {
      const cacheKey = `${claims.issuer}|${claims.subject}`;
      let id = cache.get(cacheKey);
      if (!id) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO users (issuer, subject, email, name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (issuer, subject) DO UPDATE
             SET email = COALESCE(EXCLUDED.email, users.email),
                 name = COALESCE(EXCLUDED.name, users.name),
                 updated_at = now()
           RETURNING id`,
          [claims.issuer, claims.subject, claims.email ?? null, claims.name ?? null],
        );
        id = rows[0]!.id;
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(cacheKey, id);
      }
      return { id, issuer: claims.issuer, subject: claims.subject };
    },
  };
}
