// The internal listener: a second Fastify instance, never reachable from the public one, that serves only
// /internal/v1/*. Two credentials are required on every request (ADR 0009): the static service secret,
// checked before any database access, and a per-run token whose claims are then checked against the run.
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { AppError, type Logger } from "@sentra/ts-platform";
import { installRequestContext } from "./app.ts";
import { MAX_ROUNDS, type InvestigationTools } from "./investigation-tools.ts";
import * as metrics from "./metrics.ts";
import { isUuid } from "./org-input.ts";
import { isToolName } from "./tool-contracts.ts";
import { verifyToken, type SigningKey } from "./tool-token.ts";

const MAX_BODY_BYTES = 16 * 1024;
// The model's whole answer; the worker already caps it at 16 KiB, so this leaves room for the envelope.
const MAX_COMPLETE_BODY_BYTES = 32 * 1024;

interface Deps {
  logger: Logger;
  serviceToken: string;
  signingKeys: SigningKey[];
  tools: InvestigationTools;
}

const unauthorized = (reason: string) => {
  metrics.inc("investigation_tool_auth_rejections_total", { reason });
  return new AppError("tool_unauthorized", 401, "Unauthorized", { reason });
};

const invalid = (reason: string) => new AppError("invalid_input", 400, "Invalid input", { reason });

const digest = (value: string) => createHash("sha256").update(value).digest();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRound = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ROUNDS;

export function buildInternalApp({ logger, serviceToken, signingKeys, tools }: Deps) {
  // "ignore" keeps `__proto__` and `constructor` keys as ordinary own properties, so the argument schema
  // rejects them as invalid_args instead of the parser failing the whole request with a 400.
  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    onProtoPoisoning: "ignore",
    onConstructorPoisoning: "ignore",
  });
  installRequestContext(app, logger);

  const expectedSecret = digest(serviceToken);
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    const given = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    // Equal-length digests keep the comparison constant-time whatever the caller sent.
    if (!timingSafeEqual(digest(given), expectedSecret)) throw unauthorized("bad_secret");
  });

  function authorizeRun(request: FastifyRequest, investigationId: string) {
    const header = request.headers["x-investigation-token"];
    const claims =
      typeof header === "string" ? verifyToken(signingKeys, header, Date.now() / 1000) : null;
    if (!claims) throw unauthorized("invalid_token");
    if (claims.inv !== investigationId) throw unauthorized("wrong_run");
    return claims;
  }

  // Routes register in a plugin, as on the public app, so an `onRoute` hook added after build still sees them.
  app.register(async (routes) => {
    routes.post<{ Params: { id: string } }>(
      "/internal/v1/investigations/:id/token",
      async (request) => {
        const { leaseOwner } = isObject(request.body) ? request.body : {};
        if (typeof leaseOwner !== "string" || !isUuid(leaseOwner) || !isUuid(request.params.id)) {
          throw invalid("lease_owner");
        }
        return tools.exchangeToken(request.params.id, leaseOwner);
      },
    );

    routes.post<{ Params: { id: string; tool: string } }>(
      "/internal/v1/investigations/:id/tools/:tool",
      async (request) => {
        const { id, tool } = request.params;
        const claims = authorizeRun(request, id);
        if (!isToolName(tool))
          throw new AppError("not_found", 404, "Not found", { reason: "unknown_tool" });
        const body = isObject(request.body) ? request.body : {};
        const { round, args } = body;
        if (!isRound(round)) throw invalid("round");
        if (!isObject(args)) throw invalid("args");
        return tools.callTool(
          { investigationId: id, leaseOwner: claims.lease, tool, round, args },
          request.ctx.log,
        );
      },
    );

    routes.post<{ Params: { id: string } }>(
      "/internal/v1/investigations/:id/complete",
      { bodyLimit: MAX_COMPLETE_BODY_BYTES },
      async (request) => {
        const claims = authorizeRun(request, request.params.id);
        const body = isObject(request.body) ? request.body : {};
        if (!isRound(body["round"])) throw invalid("round");
        if (!("result" in body)) throw invalid("result");
        return tools.complete(
          {
            investigationId: request.params.id,
            leaseOwner: claims.lease,
            round: body["round"],
            result: body["result"],
          },
          request.ctx.log,
        );
      },
    );
  });

  return app;
}
