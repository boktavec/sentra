import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@sentra/ts-platform";
import { isUuid } from "./org-input.ts";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import { validateNewSbom } from "./sbom-input.ts";
import type { SbomStore } from "./sbom.ts";

type Params = { orgId: string; slug: string; importId?: string };
const params = (request: FastifyRequest) => request.params as Params;

/** A malformed ID is the same 404 as a missing one, so it never reaches the database. */
const importIdOf = (request: FastifyRequest) => {
  const id = params(request).importId!;
  if (!isUuid(id))
    throw new AppError("not_found", 404, "Not found", { reason: "import_not_found" });
  return id;
};

/**
 * Registers SBOM import routes on an already-authenticated scope. Any org member may use them.
 * `sbom` is undefined when object storage is not configured.
 */
export function registerSbomRoutes(
  routes: FastifyInstance,
  deps: Deps & { sbom: SbomStore | undefined; maxBytes: number },
) {
  const scope = scopeTo(deps);
  const store = () => {
    if (!deps.sbom) throw new AppError("sbom_unavailable", 503, "SBOM upload is not available");
    return deps.sbom;
  };
  const base = "/v1/orgs/:orgId/projects/:slug/sboms";

  routes.post(base, async (request, reply) => {
    await scope(request, { orgId: params(request).orgId });
    const sbom = store();
    const input = validateNewSbom(request.body, deps.maxBytes);
    const created = await sbom.create(request.tenant!, params(request).slug, input);
    request.ctx.log.info({ importId: created.id }, "sbom_import_created");
    return reply.status(201).send(created);
  });

  routes.post(`${base}/:importId/complete`, async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const sbom = store();
    const result = await sbom.complete(
      request.tenant!,
      params(request).slug,
      importIdOf(request),
      request.ctx.correlationId,
    );
    request.ctx.log.info({ importId: result.id, status: result.status }, "sbom_import_completed");
    return result;
  });

  routes.get(base, async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const sbom = store();
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return sbom.list(request.tenant!, params(request).slug, parseLimit(limit), cursor);
  });

  routes.get(`${base}/:importId`, async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const sbom = store();
    return sbom.get(request.tenant!, params(request).slug, importIdOf(request));
  });
}
