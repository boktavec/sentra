// Per-run credential for the internal tool listener (ADR 0009). The worker obtains one from the token
// exchange; it proves the holder was handed the run's lease, and it expires with the lease.
import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface SigningKey {
  kid: string;
  key: Buffer;
}

export interface TokenClaims {
  /** Investigation ID. */
  inv: string;
  /** Lease owner at issue time. */
  lease: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** `kid:base64key[,kid:base64key]`. The first key signs; every listed key verifies. */
export function parseSigningKeys(raw: string): SigningKey[] {
  const keys = raw.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const kid = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (separator < 0 || !KEY_ID.test(kid) || !BASE64.test(encoded)) {
      throw new Error("INVESTIGATION_TOOL_SIGNING_KEYS must be kid:base64key[,kid:base64key]");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length < MIN_SECRET_BYTES) {
      throw new Error(`Signing key ${kid} must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    return { kid, key };
  });
  if (new Set(keys.map((k) => k.kid)).size !== keys.length) {
    throw new Error("INVESTIGATION_TOOL_SIGNING_KEYS contains a duplicate kid");
  }
  return keys;
}

export function assertSecretLength(name: string, value: string): void {
  if (Buffer.byteLength(value) < MIN_SECRET_BYTES) {
    throw new Error(`${name} must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

const mac = (key: Buffer, signed: string) => createHmac("sha256", key).update(signed).digest();

export function signToken(keys: SigningKey[], claims: TokenClaims): string {
  const [current] = keys;
  if (!current) throw new Error("No signing key configured");
  const signed = `v1.${current.kid}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${signed}.${mac(current.key, signed).toString("base64url")}`;
}

/** Returns the claims of a well-formed, correctly signed, unexpired token, or null for anything else. */
export function verifyToken(
  keys: SigningKey[],
  token: string,
  nowSeconds: number,
): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [version, kid, payload, signature] = parts as [string, string, string, string];
  const key = keys.find((k) => k.kid === kid)?.key;
  if (!key) return null;
  const expected = mac(key, `${version}.${kid}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    const wellFormed =
      typeof claims.inv === "string" &&
      typeof claims.lease === "string" &&
      Number.isFinite(claims.exp);
    return wellFormed && claims.exp > nowSeconds ? claims : null;
  } catch {
    return null;
  }
}
