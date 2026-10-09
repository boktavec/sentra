import Fastify, { type FastifyInstance } from "fastify";
import {
  AppError,
  requestLogger,
  resolveCorrelationId,
  toErrorResponse,
  type Logger,
} from "@sentra/ts-platform";
import { createAuthenticator } from "./auth.ts";
import * as metrics from "./metrics.ts";
import { registerFindingsRoutes } from "./findings-routes.ts";
import { registerInvestigationRoutes } from "./investigation-routes.ts";
import type { InvestigationStore } from "./investigations.ts";
import type { FindingStore } from "./findings.ts";
import { registerInvitationRoutes } from "./invitation-routes.ts";
import type { InvitationStore } from "./invitations.ts";
import { registerMemberRoutes } from "./member-routes.ts";
import type { MemberStore } from "./members.ts";
import { registerOrgRoutes } from "./org-routes.ts";
import { registerProjectRoutes } from "./project-routes.ts";
import { registerSbomRoutes } from "./sbom-routes.ts";
import type { SbomStore } from "./sbom.ts";
import type { OrgStore, TenantContext } from "./orgs.ts";
import type { ProjectStore } from "./projects.ts";
import type { AuthUser } from "./users.ts";

declare module "fastify" {
  interface FastifyRequest {
    ctx: { correlationId: string; log: Logger };
    user?: AuthUser;
    tenant?: TenantContext;
  }
}

interface Deps {
  logger: Logger;
  authenticate: ReturnType<typeof createAuthenticator>;
  orgs: OrgStore;
  members: MemberStore;
  projects: ProjectStore;
  findings: FindingStore;
  investigations?: InvestigationStore;
  /** Undefined when object storage is not configured. */
  sbom?: SbomStore | undefined;
  sbomMaxBytes?: number;
  invitations: InvitationStore;
  ready: () => Promise<boolean>;
  trustedProxies: string[] | false;
}

export function buildApp({
  logger,
  authenticate,
  orgs,
  members,
  projects,
  findings,
  investigations,
  sbom,
  sbomMaxBytes,
  invitations,
  ready,
  trustedProxies,
}: Deps) {
  const app = Fastify({ trustProxy: trustedProxies });

  installRequestContext(app, logger);

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) =>
    (await ready()) ? { status: "ready" } : reply.status(503).send({ status: "not_ready" }),
  );
  app.get("/metrics", async (_request, reply) =>
    reply.type("text/plain; version=0.0.4").send(metrics.render()),
  );

  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("onRequest", async (request) => {
      request.user = await authenticate(request, request.ctx.log);
      request.ctx.log = requestLogger(logger, request.ctx.correlationId, {
        userId: request.user.id,
      });
    });
    protectedRoutes.get("/v1/me", async (request) => ({ id: request.user!.id }));

    registerOrgRoutes(protectedRoutes, { logger, orgs });
    registerMemberRoutes(protectedRoutes, { logger, orgs, members });
    registerProjectRoutes(protectedRoutes, { logger, orgs, projects });
    registerFindingsRoutes(protectedRoutes, { logger, orgs, findings });
    if (investigations)
      registerInvestigationRoutes(protectedRoutes, { logger, orgs, investigations });
    registerSbomRoutes(protectedRoutes, { logger, orgs, sbom, maxBytes: sbomMaxBytes ?? 0 });
    registerInvitationRoutes(protectedRoutes, { logger, orgs, invitations });
  });

  return app;
}

/** Correlation ID, per-request logger, and the one place errors become responses; shared by both listeners. */
export function installRequestContext(app: FastifyInstance, logger: Logger) {
  app.decorateRequest("ctx");
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId = resolveCorrelationId(typeof incoming === "string" ? incoming : undefined);
    request.ctx = { correlationId, log: requestLogger(logger, correlationId) };
    reply.header("x-correlation-id", correlationId);
  });

  app.setErrorHandler((err, request, reply) => {
    const { correlationId, log } = request.ctx;
    const response = toErrorResponse(
      err instanceof AppError ? err : fastifyClientError(err),
      correlationId,
    );
    if (response.status >= 500) log.error({ err }, "request_failed");
    return reply.status(response.status).headers(response.headers).send(response.body);
  });
  app.setNotFoundHandler(() => {
    throw new AppError("not_found", 404, "Not found");
  });
}

/** Fastify's own 4xx errors (bad JSON, etc.) keep their status but get a generic message. */
function fastifyClientError(err: unknown): unknown {
  const status = (err as { statusCode?: number }).statusCode;
  return status && status >= 400 && status < 500
    ? new AppError("bad_request", status, "Bad request")
    : err;
}
