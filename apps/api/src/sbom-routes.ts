import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@sentra/ts-platform";
import type { Json } from "./json.ts";
import { isUuid } from "./org-input.ts";
import { parseLimit, scopeTo, type Deps } from "./org-routes.ts";
import { validateNewSbom } from "./sbom-input.ts";
import type { SbomStore } from "./sbom.ts";

interface Params {
  orgId: string;
  slug: string;
}

interface ImportParams extends Params {
  importId: string;
}

/** A malformed ID is the same 404 as a missing one, so it never reaches the database. */
const importIdOf = (request: FastifyRequest<{ Params: ImportParams }>) => {
  const id = request.params.importId;

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

  routes.post<{ Params: Params; Body: Json | undefined }>(base, async (request, reply) => {
    await scope(request, { orgId: request.params.orgId });
    const sbom = store();
    const input = validateNewSbom(request.body, deps.maxBytes);
    const created = await sbom.create(request.tenant!, request.params.slug, input);
    request.ctx.log.info({ importId: created.id }, "sbom_import_created");

    return reply.status(201).send(created);
  });

  routes.post<{ Params: ImportParams }>(`${base}/:importId/complete`, async (request) => {
    await scope(request, { orgId: request.params.orgId });
    const sbom = store();

    const result = await sbom.complete(
      request.tenant!,
      request.params.slug,
      importIdOf(request),
      request.ctx.correlationId,
    );

    request.ctx.log.info({ importId: result.id, status: result.status }, "sbom_import_completed");

    return result;
  });

  routes.get<{ Params: Params; Querystring: { limit?: string; cursor?: string } }>(
    base,
    async (request) => {
      await scope(request, { orgId: request.params.orgId });
      const sbom = store();
      const { limit, cursor } = request.query;

      return sbom.list(request.tenant!, request.params.slug, parseLimit(limit), cursor);
    },
  );

  routes.get<{ Params: ImportParams }>(`${base}/:importId`, async (request) => {
    await scope(request, { orgId: request.params.orgId });
    const sbom = store();

    return sbom.get(request.tenant!, request.params.slug, importIdOf(request));
  });
}
