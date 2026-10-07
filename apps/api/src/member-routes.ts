import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@sentra/ts-platform";
import * as metrics from "./metrics.ts";
import type { MemberStore } from "./members.ts";
import { isUuid, validateRole } from "./org-input.ts";
import { parseLimit, requireAdmin, scopeTo, type Deps } from "./org-routes.ts";

const params = (request: FastifyRequest) => request.params as { orgId: string; userId: string };

/** Counts and logs a refused membership change (the last admin) before it reaches the client. */
async function countRejection<T>(request: FastifyRequest, change: Promise<T>): Promise<T> {
  try {
    return await change;
  } catch (err) {
    const reason = err instanceof AppError ? err.reason : undefined;
    if (reason === "last_admin") {
      metrics.inc("membership_change_rejected_total", { reason });
      request.ctx.log.info({ reason }, "membership_change_rejected");
    }
    throw err;
  }
}

function recorded(
  request: FastifyRequest,
  action: "role_changed" | "removed" | "left",
  userId: string,
) {
  metrics.inc("membership_changes_total", { action });
  request.ctx.log.info({ targetUserId: userId }, `member_${action}`);
}

/** Registers member routes on an already-authenticated Fastify scope. */
export function registerMemberRoutes(
  routes: FastifyInstance,
  deps: Deps & { members: MemberStore },
) {
  const scope = scopeTo(deps);
  const { members } = deps;

  routes.get("/v1/orgs/:orgId/members", async (request) => {
    await scope(request, { orgId: params(request).orgId });
    const { limit, cursor } = request.query as { limit?: string; cursor?: string };
    return members.list(request.tenant!, parseLimit(limit), cursor);
  });

  routes.patch("/v1/orgs/:orgId/members/:userId", async (request) => {
    await scope(request, { orgId: params(request).orgId });
    requireAdmin(request);
    const role = validateRole(request.body);
    const { userId } = params(request);
    // A malformed ID is a user who is not a member.
    if (!isUuid(userId)) throw new AppError("not_found", 404, "Not found");

    const { member, changed } = await countRejection(
      request,
      members.setRole(request.tenant!, userId, role, request.ctx.correlationId),
    );
    if (changed) recorded(request, "role_changed", userId);
    return member;
  });

  // Removes a member, or leaves when the target is the caller. Idempotent: a user who is not a
  // member (already removed, never joined, other org) is a 204 with no write.
  routes.delete("/v1/orgs/:orgId/members/:userId", async (request, reply) => {
    await scope(request, { orgId: params(request).orgId });
    const { userId } = params(request);
    if (userId !== request.tenant!.userId) requireAdmin(request);
    if (!isUuid(userId)) return reply.status(204).send();

    const { removed, leaving } = await countRejection(
      request,
      members.remove(request.tenant!, userId, request.ctx.correlationId),
    );
    if (removed) recorded(request, leaving ? "left" : "removed", userId);
    return reply.status(204).send();
  });
}
