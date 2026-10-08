import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import { validateNewOrg as validateNewProject } from "./org-input.ts";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import type { ProjectStore } from "./projects.ts";

const params = (request: FastifyRequest) => request.params as { orgId: string; slug: string };
const countCreate = (outcome: string) => metrics.inc("project_create_outcomes_total", { outcome });

/** Registers project routes on an already-authenticated Fastify scope. Any org member may use them. */
export function registerProjectRoutes(
  routes: FastifyInstance,
  deps: Deps & { projects: ProjectStore },
) {
  const scope = scopeTo(deps);
  const { projects } = deps;

  routes.post("/v1/orgs/:orgId/projects", async (request, reply) => {
    await scope(request, { orgId: params(request).orgId });
    const { log, correlationId } = request.ctx;
    try {
      const input = validateNewProject(request.body);
      const { project, created } = await projects.create(request.tenant!, input, correlationId);
      countCreate(created ? "created" : "idempotent");
      if (created) log.info({ projectId: project.id }, "project_created");
      return reply.status(created ? 201 : 200).send(project);
    } catch (err) {
      const reason = (err as AppError).reason;
      if (reason) {
        countCreate(reason === "slug_taken" ? reason : "invalid");
        log.info({ reason }, "project_create_rejected");
      }
      throw err;
    }
  });

  routes.get("/v1/orgs/:orgId/projects", async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return projects.list(request.tenant!, parseLimit(limit), cursor);
  });

  routes.get("/v1/orgs/:orgId/projects/by-slug/:slug", async (request) => {
    await scope(request, { orgId: params(request).orgId });
    return projects.getBySlug(request.tenant!, params(request).slug);
  });
}
