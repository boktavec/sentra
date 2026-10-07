import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, requestLogger, type Logger } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { validateNewOrg } from "./org-input.ts";
import type { OrgStore } from "./orgs.ts";

const PAGE_LIMIT = { default: 50, max: 100 };

interface Deps {
  logger: Logger;
  orgs: OrgStore;
}

const countCreate = (outcome: string) => metrics.inc("org_create_outcomes_total", { outcome });

function createRoute({ orgs }: Deps) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { log, correlationId } = request.ctx;
    try {
      const input = validateNewOrg(request.body);
      const { org, created } = await orgs.create(request.user!.id, input, correlationId);
      countCreate(created ? "created" : "idempotent");
      if (created) log.info({ orgId: org.id }, "org_created");
      return reply.status(created ? 201 : 200).send(org);
    } catch (err) {
      const reason = (err as AppError).reason;
      if (reason) {
        countCreate(reason);
        log.info({ reason }, "org_create_rejected");
      }
      throw err;
    }
  };
}

function parseLimit(raw: string | undefined): number {
  const limit = Number(raw ?? PAGE_LIMIT.default);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT.max) {
    throw new AppError("invalid_input", 400, "Invalid input", { reason: "limit" });
  }
  return limit;
}

/** Resolves the caller's membership; its TenantContext is the only tenant input org routes use. */
function scopeTo({ logger, orgs }: Deps) {
  return async (request: FastifyRequest, by: { orgId: string } | { slug: string }) => {
    const { tenant, org } = await orgs.resolveTenant(request.user!.id, by).catch((err: unknown) => {
      if ((err as AppError).reason === "tenant_access_denied") {
        request.ctx.log.warn({ route: request.routeOptions.url }, "tenant_access_denied");
      }
      throw err;
    });
    request.tenant = tenant;
    request.ctx.log = requestLogger(logger, request.ctx.correlationId, {
      userId: tenant.userId,
      orgId: tenant.orgId,
    });
    request.ctx.log.debug("tenant_resolved");
    return org;
  };
}

/** Registers org routes on an already-authenticated Fastify scope. */
export function registerOrgRoutes(routes: FastifyInstance, deps: Deps) {
  const scope = scopeTo(deps);
  routes.post("/v1/orgs", createRoute(deps));
  routes.get("/v1/orgs", async (request) => {
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return deps.orgs.list(request.user!.id, parseLimit(limit), cursor);
  });
  routes.get("/v1/orgs/by-slug/:slug", (request) =>
    scope(request, { slug: (request.params as { slug: string }).slug }),
  );
  routes.get("/v1/orgs/:orgId", (request) =>
    scope(request, { orgId: (request.params as { orgId: string }).orgId }),
  );
}
