import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStore } from "./audits.ts";
import { requireAdmin, scopeTo, type Deps } from "./org-routes.ts";

export function registerAuditRoutes(routes: FastifyInstance, deps: Deps & { audits: AuditStore }) {
  const scope = scopeTo(deps);
  routes.get("/v1/orgs/:orgId/audit-events", async (request: FastifyRequest) => {
    await scope(request, { orgId: (request.params as { orgId: string }).orgId });
    requireAdmin(request);
    return deps.audits.list(request.tenant!, request.query as Record<string, unknown>);
  });
}
