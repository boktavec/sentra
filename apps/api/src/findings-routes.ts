import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import type { FindingStore } from "./findings.ts";
import { AppError } from "@sentra/ts-platform";
import type { FindingQuery } from "./findings.ts";

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
    const { limit, cursor, status, severity, sort } = request.query as Record<
      string,
      string | undefined
    >;
    const statusValue = status ?? "open";
    const severityValue = severity ?? "all";
    const sortValue = sort ?? "severity";
    if (!["open", "resolved", "all"].includes(statusValue))
      throw new AppError("invalid_input", 400, "Invalid input", { reason: "status" });
    if (
      !["critical", "high", "medium", "low", "none", "unavailable", "all"].includes(severityValue)
    )
      throw new AppError("invalid_input", 400, "Invalid input", { reason: "severity" });
    if (!["severity", "newest"].includes(sortValue))
      throw new AppError("invalid_input", 400, "Invalid input", { reason: "sort" });
    const query: FindingQuery = {
      limit: parseLimit(limit),
      cursor,
      status: statusValue as FindingQuery["status"],
      severity: severityValue as FindingQuery["severity"],
      sort: sortValue as FindingQuery["sort"],
    };
    return deps.findings.list(request.tenant!, params(request).slug, query);
  });
}
