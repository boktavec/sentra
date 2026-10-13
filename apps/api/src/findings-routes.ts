import type { FastifyInstance } from "fastify";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import type { FindingStore } from "./findings.ts";
import { AppError } from "@sentra/ts-platform";
import type { FindingQuery } from "./findings.ts";

interface Params {
  orgId: string;
  slug: string;
}

interface FindingParams extends Params {
  findingId: string;
}

interface ListQuery {
  limit?: string;
  cursor?: string;
  status?: string;
  severity?: string;
  sort?: string;
  priority?: string;
}

const STATUSES = ["open", "resolved", "all"] as const satisfies readonly FindingQuery["status"][];

const SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "none",
  "unavailable",
  "all",
] as const satisfies readonly FindingQuery["severity"][];

const SORTS = ["priority", "severity", "newest"] as const satisfies readonly FindingQuery["sort"][];

const PRIORITIES = [
  "all",
  "p1",
  "p2",
  "p3",
  "p4",
] as const satisfies readonly FindingQuery["priority"][];

/** The allowed value equal to `value`, or an invalid_input error naming the query parameter. */
function oneOf<T extends string>(allowed: readonly T[], value: string, reason: string): T {
  const match = allowed.find((candidate) => candidate === value);

  if (match === undefined) throw new AppError("invalid_input", 400, "Invalid input", { reason });

  return match;
}

/**
 * Registers the findings list on an already-authenticated scope. Any org member may read it. Findings are
 * derived data written by the correlator, so there are no write routes.
 */
export function registerFindingsRoutes(
  routes: FastifyInstance,
  deps: Deps & { findings: FindingStore },
) {
  const scope = scopeTo(deps);

  routes.get<{ Params: Params; Querystring: ListQuery }>(
    "/v1/orgs/:orgId/projects/:slug/findings",
    async (request) => {
      await scope(request, { orgId: request.params.orgId });

      const { limit, cursor, status, severity, sort, priority } = request.query;

      const query: FindingQuery = {
        status: oneOf(STATUSES, status ?? "open", "status"),
        severity: oneOf(SEVERITIES, severity ?? "all", "severity"),
        sort: oneOf(SORTS, sort ?? "priority", "sort"),
        priority: oneOf(PRIORITIES, priority ?? "all", "priority"),
        limit: parseLimit(limit),
        cursor,
      };

      return deps.findings.list(request.tenant!, request.params.slug, query);
    },
  );

  routes.get<{ Params: FindingParams }>(
    "/v1/orgs/:orgId/projects/:slug/findings/:findingId",
    async (request) => {
      const { orgId, slug, findingId } = request.params;
      await scope(request, { orgId });

      return deps.findings.get(request.tenant!, slug, findingId);
    },
  );
}
