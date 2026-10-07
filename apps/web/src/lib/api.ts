import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; correlationId: string };

/** Server-side call to the API with the user's access token and a propagated correlation ID. */
export async function apiGet<T>(path: string, accessToken: string): Promise<ApiResult<T>> {
  const correlationId = randomUUID();
  try {
    const res = await fetch(`${config().apiUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}`, "x-correlation-id": correlationId },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok
      ? { ok: true, data: (await res.json()) as T }
      : { ok: false, status: res.status, correlationId };
  } catch {
    return { ok: false, status: 503, correlationId };
  }
}
