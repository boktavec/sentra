import Link from "next/link";
import { CenteredLayout } from "@/components/shell/centered-layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";

// Accepting is a button (a POST), not this page load, so link previews and scanners cannot use up
// an invitation. The proxy has already sent signed-out visitors through sign-in and back here.
export default async function AcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <CenteredLayout>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1} className="text-xl">
            Join an organization
          </CardTitle>
          {token && (
            <CardDescription>
              You have been invited to join an organization on Sentra. Accept the invitation to
              become a member.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {token ? (
            <AcceptForm token={token} />
          ) : (
            <p role="alert" data-testid="accept-error" className="text-destructive">
              This invitation link is not valid.
            </p>
          )}
          <Link href="/" className="text-muted-foreground underline underline-offset-4">
            Back to home
          </Link>
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
