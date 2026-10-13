import { DataTable, type Column } from "@/components/data-table";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import { callApi } from "@/lib/auth";
import { fetchOrg, type Org } from "@/lib/orgs";
import { changeRole, leaveOrganization, removeMember, revokeInvitation } from "./actions";
import { InviteDialog } from "./invite-dialog";

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

const MESSAGES = new Map<string, string>([
  ["forbidden", "Only admins can do that."],
  ["not_found", "That member no longer exists in this organization."],
  ["last_admin", "An organization needs at least one admin."],
  ["unavailable", "The service is temporarily unavailable. Try again."],
]);

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

/** The form fields every row action needs. The server re-checks everything. */
function ActionForm({
  org,
  hidden,
  action,
  className,
  children,
}: {
  org: Org;
  hidden: Record<string, string>;
  action: (form: FormData) => Promise<void>;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <form action={action} className={className}>
      <input type="hidden" name="orgId" value={org.id} />
      <input type="hidden" name="slug" value={org.slug} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
    </form>
  );
}

function RoleForm({ org, member }: { org: Org; member: Member }) {
  return (
    <ActionForm
      org={org}
      hidden={{ userId: member.userId }}
      action={changeRole}
      className="flex items-center gap-2"
    >
      <NativeSelect
        name="role"
        defaultValue={member.role}
        aria-label={`Role for ${member.name ?? "member"}`}
        className="h-8"
      >
        <option value="admin">admin</option>
        <option value="member">member</option>
      </NativeSelect>
      <Button type="submit" variant="outline" size="sm">
        Change role
      </Button>
    </ActionForm>
  );
}

function RemoveForm({ org, member }: { org: Org; member: Member }) {
  const who = member.name ?? member.email ?? "this member";

  return (
    <ActionForm org={org} hidden={{ userId: member.userId }} action={removeMember}>
      <ConfirmSubmit
        label="Remove"
        title={`Remove ${who}?`}
        description={`They will lose access to ${org.name} immediately. You can invite them again.`}
      />
    </ActionForm>
  );
}

function LeaveForm({ org, member }: { org: Org; member: Member }) {
  return (
    <ActionForm org={org} hidden={{ userId: member.userId }} action={leaveOrganization}>
      <ConfirmSubmit
        label="Leave"
        title={`Leave ${org.name}?`}
        description="You will lose access immediately and need a new invitation to return."
      />
    </ActionForm>
  );
}

/** Admins manage everyone (and can leave); members can only leave. The API enforces the same. */
function Actions({ org, member, you }: { org: Org; member: Member; you: boolean }) {
  if (org.role !== "admin") return you ? <LeaveForm org={org} member={member} /> : null;

  return (
    <div className="flex items-center justify-end gap-2 max-sm:flex-wrap max-sm:justify-start">
      <RoleForm org={org} member={member} />
      {you ? <LeaveForm org={org} member={member} /> : <RemoveForm org={org} member={member} />}
    </div>
  );
}

function memberColumns(org: Org, youId: string): Column<Member>[] {
  const isAdmin = org.role === "admin";

  return [
    {
      key: "name",
      header: "Name",
      className: "max-sm:order-1 max-sm:col-span-2",
      cell: (member) => (
        <span className="flex items-baseline gap-1.5">
          <span className="max-w-[28ch] truncate" title={member.name ?? undefined}>
            {member.name ?? "(no name)"}
          </span>
          {member.userId === youId && <span className="text-muted-foreground">(you)</span>}
        </span>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: "email",
            header: "Email",
            className: "max-sm:order-3 max-sm:col-span-3 max-sm:text-muted-foreground",
            cell: (member: Member) => (
              <span className="block max-w-[28ch] truncate" title={member.email ?? undefined}>
                {member.email}
              </span>
            ),
          },
        ]
      : []),
    {
      key: "role",
      header: "Role",
      className: "max-sm:order-2 max-sm:justify-self-end",
      cell: (member) => (
        <Badge variant="outline" data-testid="member-role">
          {member.role}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "max-sm:order-4 max-sm:col-span-3",
      cell: (member) => <Actions org={org} member={member} you={member.userId === youId} />,
    },
  ];
}

/** The Invitations section has no LocalTime yet (SENTRA-36 PR3); a fixed UTC format is hydration-safe. */
const utcDateTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function RevokeForm({ org, invitation }: { org: Org; invitation: Invitation }) {
  return (
    <ActionForm org={org} hidden={{ invitationId: invitation.id }} action={revokeInvitation}>
      <ConfirmSubmit
        label="Revoke"
        title={`Revoke invitation for ${invitation.email}?`}
        description="The invitation link stops working. You can send a new invitation."
      />
    </ActionForm>
  );
}

function invitationColumns(org: Org): Column<Invitation>[] {
  return [
    {
      key: "email",
      header: "Email",
      className: "max-sm:order-1 max-sm:col-span-3",
      cell: (invitation) => (
        <span className="block max-w-[28ch] truncate" title={invitation.email}>
          {invitation.email}
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      className: "max-sm:order-2",
      cell: (invitation) => <Badge variant="outline">{invitation.role}</Badge>,
    },
    {
      key: "expires",
      header: "Expires",
      className: "max-sm:order-3 max-sm:text-muted-foreground",
      cell: (invitation) => (
        <time
          dateTime={invitation.expiresAt}
          className="whitespace-nowrap tabular-nums max-sm:whitespace-normal"
        >
          {utcDateTime(invitation.expiresAt)}
        </time>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "max-sm:order-4",
      cell: (invitation) => (
        <div className="flex justify-end">
          <RevokeForm org={org} invitation={invitation} />
        </div>
      ),
    },
  ];
}

/** Admins only: pending invitations, hidden when there are none. */
async function Invitations({ org }: { org: Org }) {
  if (org.role !== "admin") return null;

  const pending = await callApi((token) =>
    apiGet<{ items: Invitation[] }>(`/v1/orgs/${org.id}/invitations`, token),
  );

  if (!pending.ok)
    return (
      <section className="mt-8">
        <ErrorState
          testId="invitations-error"
          title="Could not load pending invitations"
          message="Members are unaffected. Try again shortly."
          correlationId={pending.correlationId}
        />
      </section>
    );

  if (pending.data.items.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-base font-semibold">Pending invitations</h2>
      <DataTable
        testId="invitations"
        rows={pending.data.items}
        rowKey={(invitation) => invitation.id}
        rowProps={() => ({ "data-testid": "invitation-row" })}
        columns={invitationColumns(org)}
        stackedRow="max-sm:grid-cols-[auto_1fr_auto]"
      />
    </section>
  );
}

function ActionError({ code }: { code?: string }) {
  if (!code) return null;

  return (
    <div className="mb-4">
      <ErrorState
        testId="members-error"
        title="That did not work"
        message={MESSAGES.get(code) ?? MESSAGES.get("unavailable")!}
      />
    </div>
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

  if ("failedWith" in view)
    return (
      <ErrorState
        testId="api-unavailable"
        title="The service is temporarily unavailable"
        message="Try again shortly."
        correlationId={view.failedWith}
      />
    );

  const { org, page, youId } = view;

  return (
    <>
      <PageHeader
        title="Members"
        actions={org.role === "admin" && <InviteDialog orgId={org.id} slug={org.slug} />}
      />
      <ActionError code={error} />
      <DataTable
        testId="members"
        rows={page.items}
        rowKey={(member) => member.userId}
        rowProps={(member) => ({ "data-testid": "member-row", "data-user-id": member.userId })}
        columns={memberColumns(org, youId)}
        stackedRow="max-sm:grid-cols-[1fr_auto_auto]"
        loadMoreLabel="More members"
        loadMoreHref={page.nextCursor ? `?cursor=${encodeURIComponent(page.nextCursor)}` : null}
      />
      <Invitations org={org} />
    </>
  );
}
