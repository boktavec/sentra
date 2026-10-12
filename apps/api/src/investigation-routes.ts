import type { FastifyInstance } from "fastify";
import { AppError } from "@sentra/ts-platform";
import type { InvestigationStore } from "./investigations.ts";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import * as metrics from "./metrics.ts";

interface FindingParams {
  orgId: string;
  slug: string;
  findingId: string;
}

interface InvestigationParams extends FindingParams {
  investigationId: string;
}

const base = "/v1/orgs/:orgId/projects/:slug/findings/:findingId/investigations";

export function registerInvestigationRoutes(
  routes: FastifyInstance,
  deps: Deps & { investigations: InvestigationStore },
) {
  const scope = scopeTo(deps);
  routes.post<{ Params: FindingParams }>(base, async (request, reply) => {
    const p = request.params;
    await scope(request, { orgId: p.orgId });
    let result: Awaited<ReturnType<InvestigationStore["start"]>>;

    try {
      result = await deps.investigations.start(
        request.tenant!,
        p.slug,
        p.findingId,
        request.ctx.correlationId,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === "investigation_limit") {
        metrics.inc("investigation_starts_total", { outcome: "limit_rejected" });
      }

      throw err;
    }

    const { run, created } = result;
    metrics.inc("investigation_starts_total", { outcome: created ? "created" : "reused" });

    if (created)
      request.ctx.log.info(
        { investigationId: run.id, findingId: p.findingId },
        "investigation_created",
      );

    return reply.status(created ? 201 : 200).send(run);
  });
  routes.get<{ Params: FindingParams; Querystring: { limit?: string; cursor?: string } }>(
    base,
    async (request) => {
      const p = request.params;
      await scope(request, { orgId: p.orgId });
      const { limit, cursor } = request.query;

      return deps.investigations.list(
        request.tenant!,
        p.slug,
        p.findingId,
        parseLimit(limit),
        cursor,
      );
    },
  );
  routes.get<{ Params: InvestigationParams }>(`${base}/:investigationId`, async (request) => {
    const p = request.params;
    await scope(request, { orgId: p.orgId });

    return deps.investigations.get(request.tenant!, p.slug, p.findingId, p.investigationId);
  });
  routes.get<{ Params: InvestigationParams }>(
    `${base}/:investigationId/result`,
    async (request) => {
      const p = request.params;
      await scope(request, { orgId: p.orgId });

      return deps.investigations.result(request.tenant!, p.slug, p.findingId, p.investigationId);
    },
  );
}
