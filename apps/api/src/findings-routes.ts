import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import type { FindingStore } from "./findings.ts";

type Params = { orgId: string; slug: string };
const params = (request: FastifyRequest) => request.params as Params;

/**
 * Registers the findings list on an already-authenticated scope. Any org member may read it. Findings are
 * derived data written by the correlator, so there are no write routes. SENTRA-15 adds sorting and filters,
 * SENTRA-16 the detail view.
 */
export function registerFindingsRoutes(
  routes: FastifyInstance,
  deps: Deps & { findings: FindingStore },
) {
  const scope = scopeTo(deps);

  routes.get("/v1/orgs/:orgId/projects/:slug/findings", async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return deps.findings.list(request.tenant!, params(request).slug, parseLimit(limit), cursor);
  });
}
