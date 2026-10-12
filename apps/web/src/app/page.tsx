import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { apiGet, type ApiResult } from "@/lib/api";
import { CenteredLayout } from "@/components/shell/centered-layout";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { callApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface Org {
  id: string;
  name: string;
  slug: string;
}

type OrgPage = { items: Org[]; nextCursor: string | null };

function SupportId({ me }: { me: ApiResult<{ id: string }> }) {
  if (!me.ok) return null;

  return (
    <p data-testid="signed-in" className="mt-6 text-xs text-muted-foreground">
      Support ID: <code data-testid="user-id">{me.data.id}</code>
    </p>
  );
}

function OrgRow({ org }: { org: Org }) {
  return (
    <li>
      <Link
        href={`/orgs/${org.slug}`}
        title={org.name}
        className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{org.name}</span>
          <code className="block truncate font-mono text-xs text-muted-foreground">{org.slug}</code>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function OrgItems({ page, firstPage }: { page: OrgPage; firstPage: boolean }) {
  if (page.items.length === 0 && firstPage) {
    return (
      <EmptyState
        testId="no-orgs"
        title="You are not in any organization yet."
        description="Create an organization to get started, or open the invitation link you received by email to join one."
      />
    );
  }

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <ul data-testid="org-list" className="divide-y">
          {page.items.map((org) => (
            <OrgRow key={org.id} org={org} />
          ))}
        </ul>
      </Card>
      {page.nextCursor && (
        <p className="mt-3">
          <Link
            href={`/?cursor=${encodeURIComponent(page.nextCursor)}`}
            className="text-primary underline underline-offset-4"
          >
            More organizations
          </Link>
        </p>
      )}
    </>
  );
}

function OrgList({ orgs, firstPage }: { orgs: ApiResult<OrgPage>; firstPage: boolean }) {
  if (orgs.ok) return <OrgItems page={orgs.data} firstPage={firstPage} />;

  return (
    <ErrorState
      testId="api-unavailable"
      title="Your organizations could not be loaded"
      message="Signed in, but the service is temporarily unavailable. Try again in a moment."
      correlationId={orgs.correlationId}
    />
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const me = await callApi((token) => apiGet<{ id: string }>("/v1/me", token));

  const orgs = await callApi((token) =>
    apiGet<OrgPage>(`/v1/orgs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token),
  );

  return (
    <CenteredLayout width="wide">
      <PageHeader
        title="Your organizations"
        actions={
          <Button asChild>
            <Link href="/orgs/new">
              <Plus aria-hidden />
              Create organization
            </Link>
          </Button>
        }
      />
      <OrgList orgs={orgs} firstPage={!cursor} />
      <SupportId me={me} />
    </CenteredLayout>
  );
}
