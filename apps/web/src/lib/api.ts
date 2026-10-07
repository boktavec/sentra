import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export type ApiResult<T> =
  { ok: true; data: T; status: number } | { ok: false; status: number; correlationId: string };

interface Init {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

const requestInit = (accessToken: string, correlationId: string, init: Init): RequestInit => ({
  method: init.method,
  headers: {
    authorization: `Bearer ${accessToken}`,
    "x-correlation-id": correlationId,
    ...(init.body ? { "content-type": "application/json" } : {}),
  },
  body: init.body ? JSON.stringify(init.body) : undefined,
  cache: "no-store",
  signal: AbortSignal.timeout(5000),
});

async function toResult<T>(res: Response, correlationId: string): Promise<ApiResult<T>> {
  if (!res.ok) return { ok: false, status: res.status, correlationId };
  // 204 has no body.
  const data = res.status === 204 ? undefined : await res.json();
  return { ok: true, data: data as T, status: res.status };
}

/** Server-side call to the API with the user's access token and a propagated correlation ID. */
async function apiRequest<T>(path: string, accessToken: string, init: Init): Promise<ApiResult<T>> {
  const correlationId = randomUUID();
  try {
    const res = await fetch(
      `${config().apiUrl}${path}`,
      requestInit(accessToken, correlationId, init),
    );
    return await toResult<T>(res, correlationId);
  } catch {
    return { ok: false, status: 503, correlationId };
  }
}

export const apiGet = <T>(path: string, accessToken: string) =>
  apiRequest<T>(path, accessToken, { method: "GET" });

export const apiPost = <T>(path: string, accessToken: string, body: unknown) =>
  apiRequest<T>(path, accessToken, { method: "POST", body });

export const apiPatch = <T>(path: string, accessToken: string, body: unknown) =>
  apiRequest<T>(path, accessToken, { method: "PATCH", body });

export const apiDelete = (path: string, accessToken: string) =>
  apiRequest<undefined>(path, accessToken, { method: "DELETE" });
