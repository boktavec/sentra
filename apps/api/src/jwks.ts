import { createLocalJWKSet, errors, type JWSHeaderParameters, type FlattenedJWSInput } from "jose";

type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

interface Options {
  url: string;
  /** Minimum time between refresh attempts; bounds fetches an attacker can force with random `kid`s. */
  cooldownMs?: number;
  /** Keys older than this are refreshed in the background; stale keys keep working if refresh fails. */
  maxAgeMs?: number;
  fetch?: Fetcher;
  onRefreshError?: (err: unknown) => void;
  now?: () => number;
}

export class JwksUnavailableError extends Error {}

/**
 * JWKS cache. Verification uses cached keys locally (no network per request). A refresh happens
 * only for an unknown `kid` or stale keys, is throttled, and on failure keeps serving the old keys.
 */
export class JwksCache {
  private local?: ReturnType<typeof createLocalJWKSet>;
  private fetchedAt = 0;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<void>;
  private readonly cooldownMs: number;
  private readonly maxAgeMs: number;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;

  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  get ready(): boolean {
    return this.local !== undefined;
  }

  /** Eager fetch at startup; ignores the cooldown. */
  warm(): Promise<void> {
    this.lastAttempt = Number.NEGATIVE_INFINITY;
    return this.refresh();
  }

  /** Key resolver passed to jose's `jwtVerify`. */
  getKey = async (header: JWSHeaderParameters, token: FlattenedJWSInput) => {
    if (this.local) {
      if (this.now() - this.fetchedAt > this.maxAgeMs) void this.refresh();
      try {
        return await this.local(header, token);
      } catch (err) {
        if (!(err instanceof errors.JWKSNoMatchingKey)) throw err;
      }
    }
    await this.refresh();
    if (!this.local) throw new JwksUnavailableError("signing keys not available");
    return this.local(header, token);
  };

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastAttempt < this.cooldownMs) return Promise.resolve();
    this.lastAttempt = this.now();
    this.inflight = this.fetchKeys()
      .catch((err) => this.options.onRefreshError?.(err))
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async fetchKeys(): Promise<void> {
    const res = await this.fetcher(this.options.url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`JWKS fetch failed with ${res.status}`);
    this.local = createLocalJWKSet(await res.json());
    this.fetchedAt = this.now();
  }
}
