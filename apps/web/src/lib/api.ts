import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; correlationId: string; code?: string };

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface Init {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: JsonValue;
}

function requestInit(accessToken: string, correlationId: string, init: Init): RequestInit {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    "x-correlation-id": correlationId,
  });

  if (init.body) headers.set("content-type", "application/json");

  return {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  };
}

/** The `<code>` of an RFC 9457 `urn:sentra:error:<code>` problem body, if there is one. */
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    // SAFETY: a body of any other shape makes `type?.replace` throw, which is caught below.
    const { type } = (await res.json()) as { type?: string };

    return type?.replace("urn:sentra:error:", "");
  } catch {
    return undefined;
  }
}

async function toResult<T>(res: Response, correlationId: string): Promise<ApiResult<T>> {
  if (!res.ok) return { ok: false, status: res.status, correlationId, code: await errorCode(res) };
  // 204 has no body.
  const data = res.status === 204 ? undefined : await res.json();

  // SAFETY: T is the response contract the caller declared for this first-party API route.
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

export const apiPost = <T>(path: string, accessToken: string, body?: JsonValue) =>
  apiRequest<T>(path, accessToken, { method: "POST", body });

export const apiPatch = <T>(path: string, accessToken: string, body: JsonValue) =>
  apiRequest<T>(path, accessToken, { method: "PATCH", body });

export const apiDelete = (path: string, accessToken: string) =>
  apiRequest<undefined>(path, accessToken, { method: "DELETE" });
