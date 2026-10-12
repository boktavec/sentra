import type { FastifyInstance } from "fastify";
import type { AuditQueryParams, AuditStore } from "./audits.ts";
import { requireAdmin, scopeTo, type Deps } from "./org-routes.ts";

export function registerAuditRoutes(routes: FastifyInstance, deps: Deps & { audits: AuditStore }) {
  const scope = scopeTo(deps);
  routes.get<{ Params: { orgId: string }; Querystring: AuditQueryParams }>(
    "/v1/orgs/:orgId/audit-events",
    async (request) => {
      await scope(request, { orgId: request.params.orgId });
      requireAdmin(request);

      return deps.audits.list(request.tenant!, request.query);
    },
  );
}
