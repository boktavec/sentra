import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@sentra/ts-platform";
import type { InvitationStore } from "./invitations.ts";
import * as metrics from "./metrics.ts";
import { validateAcceptBody, validateNewInvitation } from "./org-input.ts";
import { requireAdmin, scopeTo, type Deps } from "./org-routes.ts";

const outcome = (request: FastifyRequest, name: string, fields: Record<string, string> = {}) => {
  metrics.inc("invitation_outcomes_total", { outcome: name });
  request.ctx.log.info({ outcome: name, ...fields }, `invitation_${name}`);
};

/** Counts a refused invitation request by reason before the error reaches the client. */
async function countRejection<T>(request: FastifyRequest, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    const reason = err instanceof AppError ? err.reason : undefined;
    if (reason && reason !== "role_denied" && reason !== "tenant_access_denied") {
      metrics.inc("invitation_outcomes_total", { outcome: reason });
      request.ctx.log.info({ reason }, "invitation_rejected");
    }
    throw err;
  }
}

const bearerToken = (request: FastifyRequest) =>
  (request.headers.authorization ?? "").replace(/^Bearer /i, "");

/** Registers invitation routes on an already-authenticated Fastify scope. */
export function registerInvitationRoutes(
  routes: FastifyInstance,
  deps: Deps & { invitations: InvitationStore },
) {
  const scope = scopeTo(deps);
  const { invitations } = deps;
  const orgIdOf = (request: FastifyRequest) => (request.params as { orgId: string }).orgId;

  routes.post("/v1/orgs/:orgId/invitations", async (request, reply) => {
    await scope(request, { orgId: orgIdOf(request) });
    requireAdmin(request);
    const input = validateNewInvitation(request.body);
    const { invitation, token } = await countRejection(
      request,
      invitations.create(request.tenant!, input, request.ctx.correlationId),
    );
    outcome(request, "created", { invitationId: invitation.id });
    return reply.status(201).send({ ...invitation, token });
  });

  routes.get("/v1/orgs/:orgId/invitations", async (request) => {
    await scope(request, { orgId: orgIdOf(request) });
    requireAdmin(request);
    return { items: await invitations.list(request.tenant!) };
  });

  routes.delete("/v1/orgs/:orgId/invitations/:invitationId", async (request, reply) => {
    await scope(request, { orgId: orgIdOf(request) });
    requireAdmin(request);
    const { invitationId } = request.params as { invitationId: string };
    const revoked = await invitations.revoke(
      request.tenant!,
      invitationId,
      request.ctx.correlationId,
    );
    if (revoked) outcome(request, "revoked", { invitationId });
    return reply.status(204).send();
  });

  // Not org-scoped: the token identifies the invitation, and nothing about the org is returned
  // until the caller's verified email matches.
  routes.post("/v1/invitations/accept", async (request) => {
    const token = validateAcceptBody(request.body);
    const { org, retry } = await countRejection(
      request,
      invitations.accept(request.user!.id, bearerToken(request), token, request.ctx.correlationId),
    );
    outcome(request, retry ? "idempotent" : "accepted", { orgId: org.id });
    return org;
  });
}
