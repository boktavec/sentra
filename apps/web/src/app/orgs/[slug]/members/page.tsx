import Link from "next/link";
import { apiGet } from "@/lib/api";
import { callApi } from "@/lib/auth";
import { fetchOrg, type Org } from "@/lib/orgs";
import { changeRole, leaveOrganization, removeMember, revokeInvitation } from "./actions";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

interface Member {
  userId: string;
  name: string | null;
  email?: string | null;
  role: "admin" | "member";
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: string;
}

type MemberPage = { items: Member[]; nextCursor: string | null };

const MESSAGES: Record<string, string> = {
  forbidden: "Only admins can do that.",
  not_found: "That member no longer exists in this organization.",
  last_admin: "An organization needs at least one admin.",
  unavailable: "The service is temporarily unavailable. Try again.",
};

const failure = (result: { correlationId: string }) => ({ failedWith: result.correlationId });

async function loadMembers(orgId: string, cursor?: string) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const [me, page] = await Promise.all([
    callApi((token) => apiGet<{ id: string }>("/v1/me", token)),
    callApi((token) => apiGet<MemberPage>(`/v1/orgs/${orgId}/members${query}`, token)),
  ]);
  return { me, page };
}

/** Loads what the page needs, or the correlation ID of the call that failed. */
async function load(slug: string, cursor?: string) {
  const org = await fetchOrg(slug);
  if (!org.ok) return failure(org);
  const { me, page } = await loadMembers(org.data.id, cursor);
  if (!me.ok) return failure(me);
  if (!page.ok) return failure(page);
  return { org: org.data, youId: me.data.id, page: page.data };
}

/** The form fields every member action needs. The server re-checks everything. */
function ActionForm(props: {
  org: Org;
  member: Member;
  action: (form: FormData) => Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <form action={props.action}>
      <input type="hidden" name="orgId" value={props.org.id} />
      <input type="hidden" name="slug" value={props.org.slug} />
      <input type="hidden" name="userId" value={props.member.userId} />
      {props.children}
    </form>
  );
}

function RoleForm({ org, member }: { org: Org; member: Member }) {
  return (
    <ActionForm org={org} member={member} action={changeRole}>
      <select
        name="role"
        defaultValue={member.role}
        aria-label={`Role for ${member.name ?? "member"}`}
      >
        <option value="admin">admin</option>
        <option value="member">member</option>
      </select>{" "}
      <button type="submit">Change role</button>
    </ActionForm>
  );
}

function RemoveForm({ org, member }: { org: Org; member: Member }) {
  return (
    <ActionForm org={org} member={member} action={removeMember}>
      <button type="submit">Remove</button>
    </ActionForm>
  );
}

function LeaveForm({ org, member }: { org: Org; member: Member }) {
  return (
    <ActionForm org={org} member={member} action={leaveOrganization}>
      <button type="submit">Leave</button>
    </ActionForm>
  );
}

/** Admins manage everyone (and can leave); members can only leave. The API enforces the same. */
function Actions({ org, member, you }: { org: Org; member: Member; you: boolean }) {
  if (org.role !== "admin") return you ? <LeaveForm org={org} member={member} /> : null;
  return (
    <>
      <RoleForm org={org} member={member} />
      {you ? <LeaveForm org={org} member={member} /> : <RemoveForm org={org} member={member} />}
    </>
  );
}

function MemberRow({ org, member, youId }: { org: Org; member: Member; youId: string }) {
  const you = member.userId === youId;
  return (
    <tr data-testid="member-row" data-user-id={member.userId}>
      <td>
        {member.name ?? "(no name)"} {you && <em>(you)</em>}
      </td>
      {org.role === "admin" && <td>{member.email}</td>}
      <td data-testid="member-role">{member.role}</td>
      <td>
        <Actions org={org} member={member} you={you} />
      </td>
    </tr>
  );
}

function MembersTable({ org, page, youId }: { org: Org; page: MemberPage; youId: string }) {
  return (
    <table data-testid="members">
      <thead>
        <tr>
          <th>Name</th>
          {org.role === "admin" && <th>Email</th>}
          <th>Role</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {page.items.map((member) => (
          <MemberRow key={member.userId} org={org} member={member} youId={youId} />
        ))}
      </tbody>
    </table>
  );
}

function PendingRow({ org, invitation }: { org: Org; invitation: Invitation }) {
  return (
    <tr data-testid="invitation-row">
      <td>{invitation.email}</td>
      <td>{invitation.role}</td>
      <td>{new Date(invitation.expiresAt).toLocaleDateString("en-US")}</td>
      <td>
        <form action={revokeInvitation}>
          <input type="hidden" name="orgId" value={org.id} />
          <input type="hidden" name="slug" value={org.slug} />
          <input type="hidden" name="invitationId" value={invitation.id} />
          <button type="submit">Revoke</button>
        </form>
      </td>
    </tr>
  );
}

/** Admins only: invite someone and see (and revoke) pending invitations. */
async function Invitations({ org }: { org: Org }) {
  if (org.role !== "admin") return null;
  const pending = await callApi((token) =>
    apiGet<{ items: Invitation[] }>(`/v1/orgs/${org.id}/invitations`, token),
  );
  const items = pending.ok ? pending.data.items : [];
  return (
    <section>
      <h2>Invite someone</h2>
      <InviteForm orgId={org.id} slug={org.slug} />
      {items.length > 0 && (
        <table data-testid="invitations">
          <thead>
            <tr>
              <th>Pending invitation</th>
              <th>Role</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((invitation) => (
              <PendingRow key={invitation.id} org={org} invitation={invitation} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ErrorNotice({ code }: { code?: string }) {
  if (!code) return null;
  return (
    <p role="alert" data-testid="members-error">
      {MESSAGES[code] ?? MESSAGES["unavailable"]}
    </p>
  );
}

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ cursor?: string; error?: string }>;
}) {
  const [{ slug }, { cursor, error }] = await Promise.all([params, searchParams]);
  const view = await load(slug, cursor);
  if ("failedWith" in view) {
    return (
      <main>
        <p data-testid="api-unavailable">
          The service is temporarily unavailable. Reference: {view.failedWith}
        </p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href={`/orgs/${view.org.slug}`}>{view.org.name}</Link>
      </p>
      <h1>Members</h1>
      <ErrorNotice code={error} />
      <MembersTable org={view.org} page={view.page} youId={view.youId} />
      <Invitations org={view.org} />
      {view.page.nextCursor && (
        <p>
          <Link href={`?cursor=${encodeURIComponent(view.page.nextCursor)}`}>More members</Link>
        </p>
      )}
    </main>
  );
}
