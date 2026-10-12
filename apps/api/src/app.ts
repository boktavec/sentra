import { Ajv } from "ajv";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  AppError,
  requestLogger,
  resolveCorrelationId,
  toErrorResponse,
  type Logger,
} from "@sentra/ts-platform";
import { createAuthenticator } from "./auth.ts";
import { registerAuditRoutes } from "./audit-routes.ts";
import type { AuditStore } from "./audits.ts";
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
    failureCode?: string;
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
  /** Optional only for focused route tests that do not register audit history. */
  audits?: AuditStore;
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
  audits,
  ready,
  trustedProxies,
}: Deps) {
  const app = Fastify({ trustProxy: trustedProxies });

  installRequestContext(app, logger);
  app.addHook("onSend", failedResponse(audits));

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

    if (audits) registerAuditRoutes(protectedRoutes, { logger, orgs, audits });
  });

  return app;
}

/** Correlation ID, per-request logger, and the one place errors become responses; shared by both listeners. */
export function installRequestContext(app: FastifyInstance, logger: Logger) {
  app.decorateRequest("ctx");
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    const correlationId = resolveCorrelationId(Array.isArray(incoming) ? undefined : incoming);
    request.ctx = { correlationId, log: requestLogger(logger, correlationId) };
    reply.header("x-correlation-id", correlationId);
  });

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    const { correlationId, log } = request.ctx;
    const safeError = err instanceof AppError ? err : fastifyClientError(err);
    request.failureCode = safeError instanceof AppError ? safeError.code : "internal_error";
    const response = toErrorResponse(safeError, correlationId);

    if (response.status >= 500) log.error({ err }, "request_failed");

    return reply.status(response.status).headers(response.headers).send(response.body);
  });
  app.setNotFoundHandler(() => {
    throw new AppError("not_found", 404, "Not found");
  });
}

interface FailureAction {
  action: string;
  targetType: "user" | "invitation" | "project" | "sbom_import" | "investigation";
}

const FAILURE_ACTIONS = new Map<string, FailureAction>([
  ["POST /v1/orgs/:orgId/projects", { action: "project.create", targetType: "project" }],
  [
    "POST /v1/orgs/:orgId/projects/:slug/sboms",
    { action: "sbom.upload_initiated", targetType: "sbom_import" },
  ],
  [
    "POST /v1/orgs/:orgId/projects/:slug/sboms/:importId/complete",
    { action: "sbom.upload_completed", targetType: "sbom_import" },
  ],
  ["PATCH /v1/orgs/:orgId/members/:userId", { action: "member.role_changed", targetType: "user" }],
  ["DELETE /v1/orgs/:orgId/members/:userId", { action: "member.removed", targetType: "user" }],
  ["POST /v1/orgs/:orgId/invitations", { action: "invitation.create", targetType: "invitation" }],
  [
    "DELETE /v1/orgs/:orgId/invitations/:invitationId",
    { action: "invitation.revoked", targetType: "invitation" },
  ],
  [
    "POST /v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations",
    { action: "investigation.create", targetType: "investigation" },
  ],
]);

interface FailureLog {
  status: number;
  route: string;
  requestIp: string;
  failureCode: string;
  userId?: string;
  orgId?: string;
}

/** Route params are untyped at this hook; only the member routes carry a `userId`. */
const hasUserId = new Ajv({ strict: true }).compile<{ userId: string }>({
  type: "object",
  required: ["userId"],
  properties: { userId: { type: "string" } },
});

function failureAction(request: FastifyRequest, route: string) {
  const action = FAILURE_ACTIONS.get(`${request.method} ${route}`);

  if (
    action?.action === "member.removed" &&
    hasUserId(request.params) &&
    request.user?.id === request.params.userId
  ) {
    return { ...action, action: "member.left" };
  }

  return action;
}

function failedResponse(audits: AuditStore | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (reply.statusCode < 400) return;
    const route = request.routeOptions.url ?? "unmatched";
    const failureCode = request.failureCode ?? "internal_error";

    const fields: FailureLog = {
      status: reply.statusCode,
      route,
      requestIp: request.ip,
      failureCode,
    };

    if (request.user) fields.userId = request.user.id;

    if (request.tenant) fields.orgId = request.tenant.orgId;
    request.ctx.log.warn(fields, "api_request_failed");
    const action = failureAction(request, route);

    if (action && request.tenant) {
      await audits?.recordFailure({
        tenant: request.tenant,
        action: action.action,
        targetType: action.targetType,
        correlationId: request.ctx.correlationId,
        failureCode,
      });
    }
  };
}

/** Fastify's own 4xx errors (bad JSON, etc.) keep their status but get a generic message. */
function fastifyClientError(err: FastifyError): Error {
  const status = err.statusCode;

  return status && status >= 400 && status < 500
    ? new AppError("bad_request", status, "Bad request")
    : err;
}
