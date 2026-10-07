import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AppError,
  createLogger,
  rateLimited,
  requestLogger,
  resolveCorrelationId,
  toErrorResponse,
  unauthenticated,
} from "./index.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { lines, destination };
}

describe("toErrorResponse", () => {
  it("hides the internal reason and cause of an auth failure", () => {
    const err = unauthenticated("invalid_signature", new Error("secret internals"));
    const res = toErrorResponse(err, "cid-1");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    expect(res.body).toEqual({
      type: "urn:sentra:error:unauthenticated",
      title: "Authentication required",
      status: 401,
      correlationId: "cid-1",
    });
    expect(JSON.stringify(res)).not.toMatch(/invalid_signature|secret internals/);
  });

  it("sets Retry-After on rate limiting", () => {
    const res = toErrorResponse(rateLimited(42), "cid-2");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
  });

  it("turns unknown errors into a generic 500", () => {
    const res = toErrorResponse(new Error("db password is hunter2"), "cid-3");
    expect(res.status).toBe(500);
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  it("preserves status for custom AppErrors", () => {
    expect(toErrorResponse(new AppError("x", 409, "Conflict"), "c").status).toBe(409);
  });
});

describe("logger", () => {
  it("emits structured JSON with service and correlation ID, redacting secrets", () => {
    const { lines, destination } = capture();
    const log = requestLogger(createLogger("api", { destination }), "cid-4", { userId: "u1" });
    log.info(
      {
        req: { headers: { authorization: "Bearer abc.def.ghi", cookie: "s=1" } },
        accessToken: "tok",
        nested: { password: "pw" },
      },
      "auth_success",
    );
    const line = lines[0]!;
    expect(line).toMatchObject({
      level: "info",
      service: "api",
      message: "auth_success",
      correlationId: "cid-4",
      userId: "u1",
    });
    expect(typeof line["timestamp"]).toBe("string");
    expect(JSON.stringify(line)).not.toMatch(/abc\.def\.ghi|"tok"|"pw"|s=1/);
  });
});

describe("resolveCorrelationId", () => {
  it("keeps a well-formed incoming ID and replaces garbage", () => {
    expect(resolveCorrelationId("abc-123")).toBe("abc-123");
    expect(resolveCorrelationId('bad id"\n')).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
