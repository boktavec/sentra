import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AppError } from "@sentra/ts-platform";
import { invitationEmail } from "./invitation-email.ts";
import { assertStillAdmin, lockOrg, recordAudit } from "./org-tx.ts";
import { isUuid } from "./org-input.ts";
import { inTransaction, type Role, type TenantContext } from "./orgs.ts";
import type { Profile, ProfileFetcher } from "./profile.ts";

interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

export interface InvitationLimits {
  ttlHours: number;
  maxPending: number;
  maxPerDay: number;
  maxMembers: number;
}

interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  created_at: Date;
  expires_at: Date;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token: string) => createHash("sha256").update(token).digest();

const toInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  email: row.email,
  role: row.role,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
});

const refused = (code: string, status: number, message: string, reason: string) =>
  new AppError(code, status, message, { reason });

/** Revokes the pending invitation for this email, if any, so inviting again replaces it. */
async function revokeReplaced(
  client: PoolClient,
  tenant: TenantContext,
  email: string,
  correlationId: string,
) {
  const { rows } = await client.query<{ id: string; role: Role }>(
    `UPDATE invitations SET status = 'revoked'
     WHERE org_id = $1 AND email = $2 AND status = 'pending' RETURNING id, role`,
    [tenant.orgId, email],
  );
  for (const old of rows) {
    await recordAudit(client, {
      orgId: tenant.orgId,
      actorUserId: tenant.userId,
      correlationId,
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: old.id,
      metadata: { role: old.role, reason: "replaced" },
    });
  }
}

async function enforceInviteCaps(client: PoolClient, orgId: string, limits: InvitationLimits) {
  const { rows } = await client.query<{ pending: number; recent: number }>(
    `SELECT count(*) FILTER (WHERE status = 'pending' AND expires_at > now())::int AS pending,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS recent
     FROM invitations WHERE org_id = $1`,
    [orgId],
  );
  if (rows[0]!.pending >= limits.maxPending || rows[0]!.recent >= limits.maxPerDay) {
    throw refused("invitation_limit_reached", 403, "Invitation limit reached", "limit");
  }
}

/** The email is written with the invitation, so it is never lost if the mail server is down. */
async function enqueueEmail(
  client: PoolClient,
  tenant: TenantContext,
  invitation: Invitation,
  token: string,
  webUrl: string,
) {
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM organizations WHERE id = $1",
    [tenant.orgId],
  );
  const email = invitationEmail({
    orgName: rows[0]!.name,
    role: invitation.role,
    to: invitation.email,
    link: `${webUrl}/invitations/accept?token=${token}`,
    expiresAt: new Date(invitation.expiresAt),
  });
  await client.query(
    "INSERT INTO invitation_emails (invitation_id, subject, body) VALUES ($1, $2, $3)",
    [invitation.id, email.subject, email.body],
  );
}

function createInvitation(pool: Pool, limits: InvitationLimits, webUrl: string) {
  return (tenant: TenantContext, input: { email: string; role: Role }, correlationId: string) =>
    inTransaction(pool, async (client) => {
      await lockOrg(client, tenant.orgId);
      await assertStillAdmin(client, tenant);
      await revokeReplaced(client, tenant, input.email, correlationId);
      await enforceInviteCaps(client, tenant.orgId, limits);

      const token = randomBytes(32).toString("base64url");
      const { rows } = await client.query<InvitationRow>(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         RETURNING id, email, role, created_at, expires_at`,
        [tenant.orgId, input.email, input.role, hashToken(token), tenant.userId, limits.ttlHours],
      );
      const invitation = toInvitation(rows[0]!);
      await recordAudit(client, {
        orgId: tenant.orgId,
        actorUserId: tenant.userId,
        correlationId,
        action: "invitation.created",
        targetType: "invitation",
        targetId: invitation.id,
        metadata: { role: input.role },
      });
      await enqueueEmail(client, tenant, invitation, token, webUrl);
      // The token is returned once; the database keeps its hash and, until the email is sent, the link.
      return { invitation, token };
    });
}

function listInvitations(pool: Pool) {
  return async (tenant: TenantContext): Promise<Invitation[]> => {
    const { rows } = await pool.query<InvitationRow>(
      `SELECT id, email, role, created_at, expires_at FROM invitations
       WHERE org_id = $1 AND status = 'pending' AND expires_at > now()
       ORDER BY created_at, id`,
      [tenant.orgId],
    );
    return rows.map(toInvitation);
  };
}

/** Revoking something that is not pending (or does not exist) succeeds without a write. */
function revokeInvitation(pool: Pool) {
  return (tenant: TenantContext, invitationId: string, correlationId: string) =>
    inTransaction(pool, async (client) => {
      await lockOrg(client, tenant.orgId);
      await assertStillAdmin(client, tenant);
      if (!isUuid(invitationId)) return false;
      const { rows } = await client.query<{ role: Role }>(
        `UPDATE invitations SET status = 'revoked'
         WHERE id = $1 AND org_id = $2 AND status = 'pending' RETURNING role`,
        [invitationId, tenant.orgId],
      );
      if (!rows[0]) return false;
      await recordAudit(client, {
        orgId: tenant.orgId,
        actorUserId: tenant.userId,
        correlationId,
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: invitationId,
        metadata: { role: rows[0].role, reason: "revoked" },
      });
      return true;
    });
}

interface AcceptRow {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  status: "pending" | "accepted" | "revoked";
  accepted_by: string | null;
  expired: boolean;
}

const INVITATION_FOR_ACCEPT = `SELECT id, org_id, email, role, status, accepted_by, expires_at <= now() AS expired
  FROM invitations WHERE token_hash = $1`;

async function orgFor(client: PoolClient, orgId: string, userId: string) {
  const { rows } = await client.query<{
    id: string;
    name: string;
    slug: string;
    role: Role;
  }>(
    `SELECT o.id, o.name, o.slug, m.role FROM organizations o
     JOIN memberships m ON m.org_id = o.id AND m.user_id = $2 WHERE o.id = $1`,
    [orgId, userId],
  );
  return rows[0];
}

/** Decides whether this invitation may be accepted by this person, or why not. */
function checkAcceptable(invitation: AcceptRow, userId: string, profile: Profile) {
  if (invitation.status === "accepted" && invitation.accepted_by === userId) return "retry";
  if (invitation.status !== "pending") {
    throw refused("invitation_unavailable", 410, "Invitation unavailable", "unavailable");
  }
  if (invitation.expired) throw refused("invitation_expired", 410, "Invitation expired", "expired");
  if (!profile.emailVerified || profile.email !== invitation.email) {
    throw refused(
      "invitation_email_mismatch",
      403,
      "Invitation is for a different email",
      "mismatch",
    );
  }
  return "pending";
}

async function joinOrg(
  client: PoolClient,
  invitation: AcceptRow,
  userId: string,
  maxMembers: number,
  correlationId: string,
) {
  const { rows } = await client.query<{ role: Role }>(
    "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
    [invitation.org_id, userId],
  );
  if (!rows[0]) {
    const { rows: counts } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1",
      [invitation.org_id],
    );
    if (counts[0]!.n >= maxMembers) {
      throw refused("member_limit_reached", 403, "Member limit reached", "member_limit");
    }
    await client.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)", [
      invitation.org_id,
      userId,
      invitation.role,
    ]);
  }
  await client.query(
    "UPDATE invitations SET status = 'accepted', accepted_by = $2, accepted_at = now() WHERE id = $1",
    [invitation.id, userId],
  );
  await recordAudit(client, {
    orgId: invitation.org_id,
    actorUserId: userId,
    correlationId,
    action: "invitation.accepted",
    targetType: "invitation",
    targetId: invitation.id,
    metadata: { role: invitation.role, ...(rows[0] ? { alreadyMember: "true" } : {}) },
  });
}

/**
 * The caller's profile is fetched before any lock is taken. The org lock comes before the
 * invitation is re-read so lock order matches create and revoke (no deadlock).
 */
function acceptInvitation(pool: Pool, limits: InvitationLimits, fetchProfile: ProfileFetcher) {
  return async (userId: string, accessToken: string, token: string, correlationId: string) => {
    if (!TOKEN.test(token)) throw refused("not_found", 404, "Not found", "unknown");
    const tokenHash = hashToken(token);
    const first = await pool.query<AcceptRow>(INVITATION_FOR_ACCEPT, [tokenHash]);
    if (!first.rows[0]) throw refused("not_found", 404, "Not found", "unknown");
    const profile = await fetchProfile(accessToken);

    return inTransaction(pool, async (client) => {
      await lockOrg(client, first.rows[0]!.org_id);
      const { rows } = await client.query<AcceptRow>(INVITATION_FOR_ACCEPT, [tokenHash]);
      const invitation = rows[0]!;
      const state = checkAcceptable(invitation, userId, profile);
      if (state === "pending") {
        await joinOrg(client, invitation, userId, limits.maxMembers, correlationId);
      }
      const org = await orgFor(client, invitation.org_id, userId);
      // A used invitation cannot bring back someone who has since left.
      if (!org)
        throw refused("invitation_unavailable", 410, "Invitation unavailable", "unavailable");
      return { org, retry: state === "retry" };
    });
  };
}

export function createInvitationStore(
  pool: Pool,
  options: { limits: InvitationLimits; fetchProfile: ProfileFetcher; webUrl: string },
) {
  return {
    create: createInvitation(pool, options.limits, options.webUrl),
    list: listInvitations(pool),
    revoke: revokeInvitation(pool),
    accept: acceptInvitation(pool, options.limits, options.fetchProfile),
  };
}

export type InvitationStore = ReturnType<typeof createInvitationStore>;
